/*eslint no-unused-vars: ["error", { "argsIgnorePattern": "^_plugin$" }]*/
import PouchDB from 'pouchdb-browser';
import axios from 'axios';
import _ from 'lodash'

import {
  _clone,
  randId,
  debounce,
  url_regex,
  githubImJoyManifest,
  githubUrlRaw,
  assert
} from './utils.js'

import {
  parseComponent
} from './pluginParser.js'

import {
  DynamicPlugin
} from './jailed/jailed.js'

import {
  REGISTER_SCHEMA,
  WINDOW_SCHEMA,
  PLUGIN_SCHEMA,
  CONFIGURABLE_FIELDS,
  SUPPORTED_PLUGIN_TYPES,
  upgradePluginAPI
} from './api.js'


import {
  Joy
} from './joy'

import Ajv from 'ajv'
const ajv = new Ajv()

export class PluginManager {
  constructor({event_bus=null, engine_manager=null, window_manager=null, imjoy_api={}, show_message_callback=null}){
    this.event_bus = event_bus
    this.em = engine_manager
    this.wm = window_manager
    assert(this.event_bus)
    assert(this.em)
    assert(this.wm)

    this.show_message_callback = show_message_callback

    this.default_repository_list = [{name: 'ImJoy Repository', url: "oeway/ImJoy-Plugins", description: 'The official plugin repository provided by ImJoy.io.'},
                                    {name: 'ImJoy Demos', url: 'oeway/ImJoy-Demo-Plugins', description: 'A set of demo plugins provided by ImJoy.io'}
    ]
    this.config_db = new PouchDB('imjoy_config', {
      revs_limit: 2,
      auto_compaction: true
    })
    this.default_repository_list = [{name: 'ImJoy Repository', url: "oeway/ImJoy-Plugins", description: 'The official plugin repository provided by ImJoy.io.'},
                                    {name: 'ImJoy Demos', url: 'oeway/ImJoy-Demo-Plugins', description: 'A set of demo plugins provided by ImJoy.io'}
    ]
    this.repository_list = []
    this.repository_names = []
    this.available_plugins = []
    this.installed_plugins = []
    this.workspace_list = []
    this.selected_workspace = null
    this.selected_repository = null
    this.workflow_list = []
    this.windows = []
    this.window_ids = {}

    this.db = null
    this.plugins = {}
    this.plugin_names = {}
    this.registered = {
      ops: {},
      windows: {},
      extensions: {},
      inputs: {},
      outputs: {},
      loaders: {}
    }
    const api_utils_ = imjoy_api.utils
    this.imjoy_api = {
      register: this.register,
      createWindow: this.createWindow,
      updateWindow: this.updateWindow,
      run: this.runPlugin,
      call: this.callPlugin,
      getPlugin: this.getPlugin,
      setConfig: this.setPluginConfig,
      getConfig: this.getPluginConfig,
      getAttachment: this.getAttachment,
      utils: {}
    }
    // bind this to api functions
    for(let k in this.imjoy_api){
      if(typeof this.imjoy_api[k] === 'function'){
        this.imjoy_api[k] = this.imjoy_api[k].bind(this)
      }
      else if(typeof this.imjoy_api[k] === 'object'){
        for(let u in this.imjoy_api[k]){
          this.imjoy_api[k][u] = this.imjoy_api[k][u].bind(this)
        }
      }
    }
    // merge imjoy api
    this.imjoy_api = _.assign({}, imjoy_api, this.imjoy_api)
    // copy api utils make sure it was not overwritten
    if(api_utils_){
      for(let k in api_utils_){
        this.imjoy_api.utils[k] = api_utils_[k]
      }
    }
  }

  showMessage(msg, duration){
    if(this.show_message_callback){
      this.show_message_callback(msg, duration)
    }
    else{
      console.log(`PLUGIN MESSAGE: ${msg}`)
    }
  }

  resetPlugins(){
    this.plugins = {}
    this.plugin_names = {}
    this.registered = {
      ops: {},
      windows: {},
      extensions: {},
      internal_inputs: {},
      inputs: {},
      outputs: {},
      loaders: {}
    }
    this.setInputLoaders(this.getDefaultInputLoaders())
  }

  loadRepositoryList(){
    return new Promise((resolve, reject)=>{
      this.config_db.get('repository_list').then((doc) => {
        this.repository_list = doc.list
        for(let drep of this.default_repository_list){
          let found = false
          for(let repo of this.repository_list){
            if(repo.url === drep.url && repo.name === drep.name){
              found = repo
              break
            }
          }
          if(!found){
            this.addRepository(drep)
          }
        }
        this.repository_names = []
        for(let r of this.repository_list){
          this.repository_names.push(r.name)
        }
        resolve(this.repository_list)
      }).catch((err) => {
        if(err.name != 'not_found'){
          console.error("Database Error", err)
        }
        else{
          console.log('Failed to load repository list', err)
        }
        this.repository_list = this.default_repository_list
        this.config_db.put({
          _id: 'repository_list',
          list: this.repository_list
        }).then(()=>{
          resolve(this.repository_list)
        }).catch(()=>{
          reject('Failed to load the repository list or save the default repositories.')
        })
      })
    })
  }

  addRepository(repo){
    if(typeof repo === 'string'){
      repo = {name: repo, url: repo, description: repo}
    }
    assert(repo.name && repo.url)
    this.reloadRepository(repo).then((manifest)=>{
      repo.name = manifest.name || repo.name
      repo.description = manifest.description || repo.description
      // use repo url if name exists
      for(let r of this.repository_list){
        if(r.name === repo.name){
          repo.name = repo.url.replace('https://github.com/', '').replace('http://github.com/', '')
          break
        }
      }
      //remove existing repo if same url already exists
      for(let r of this.repository_list){
        if(r.url === repo.url){
          // remove it if already exists
          this.repository_list.splice( this.repository_list.indexOf(r), 1 )
          this.showMessage("Repository with the same url already exists.")
          break
        }
      }

      this.repository_list.push(repo)
      this.repository_names = []
      for(let r of this.repository_list){
        this.repository_names.push(r.name)
      }
      this.config_db.get('repository_list').then((doc) => {
        this.config_db.put({
          _id: doc._id,
          _rev: doc._rev,
          list: this.repository_list,
        })
      }).catch((err) => {
        this.showMessage("Failed to save repository, database Error:" + err.toString())
      })
    }).catch(()=>{
      if(this.repository_names.indexOf(repo.name)>=0)
        this.repository_names.splice(this.repository_names.indexOf(repo.name), 1)
      this.showMessage("Failed to load repository from: " + repo.url)
    })
  }

  removeRepository(repo) {
    if(!repo) return;
    let found = false
    for(let r of this.repository_list){
      if(r.url === repo.url || r.name === repo.name){
        found = r
      }
    }
    if (found) {
      const index = this.repository_list.indexOf(found)
      this.repository_list.splice(index, 1)
      this.repository_names = []
      for(let r of this.repository_list){
        this.repository_names.push(r.name)
      }
      this.config_db.get('repository_list').then((doc) => {
        this.config_db.put({
          _id: doc._id,
          _rev: doc._rev,
          list: this.repository_list
        }).then(()=>{
          this.showMessage(`Repository has been deleted.`)
        }).catch(()=>{
          this.showMessage(`Error occured when removing repository.`)
        })
      })
      .catch((err) => {
        this.showMessage("Failed to save repository, database Error:" + err.toString())
      })
    }
  }

  reloadRepository(repo){
    repo = repo || this.selected_repository
    return new Promise((resolve, reject)=>{
        this.getRepoManifest(repo.url).then((manifest)=>{
          this.available_plugins = manifest.plugins
          for (let i = 0; i < this.available_plugins.length; i++) {
            const ap = this.available_plugins[i]
            const ps = this.installed_plugins.filter((p) => {
              return ap.name === p.name
            })
            // mark as installed
            if(ps.length>0){
              ap.installed = true
              ap.tag = ps[0].tag
            }
          }
          this.selected_repository = repo
          resolve(manifest)
        }).catch(reject)
    })
  }

  loadWorkspaceList(){
    return new Promise((resolve, reject)=>{
      this.config_db.get('workspace_list').then((doc) => {
        this.workspace_list = doc.list
        this.selected_workspace = this.workspace_list[0]
        resolve(this.workspace_list)
      }).catch((err) => {
        if(err.name != 'not_found'){
          console.error("Database Error", err)
        }
        this.workspace_list = ['default']
        this.config_db.put({
          _id: 'workspace_list',
          list: this.workspace_list
        }).then(()=>{
          this.selected_workspace = this.workspace_list[0]
          resolve(this.workspace_list)
        }).catch(()=>{
          reject("Database Error:" + err.toString())
        })
      })
    })
  }

  loadWorkspace(selected_workspace){
    return new Promise((resolve, reject)=>{
      selected_workspace = selected_workspace || this.selected_workspace
      const load_ = ()=>{
        this.event_bus.$emit('workspace_list_updated', this.workspace_list)
        this.db = new PouchDB(selected_workspace + '_workspace', {
          revs_limit: 2,
          auto_compaction: true
        })
        this.selected_workspace = selected_workspace
        resolve()
      }
      if (!this.workspace_list.includes(selected_workspace)) {
        if (!this.workspace_list.includes(selected_workspace)) {
          this.workspace_list.push(selected_workspace)
        }
        this.config_db.get('workspace_list').then((doc) => {
          this.config_db.put({
            _id: doc._id,
            _rev: doc._rev,
            list: this.workspace_list,
            default: 'default'
          }).then(load_).catch((e)=>{
            reject("Database Error:" + e.toString())
          })
        }).catch((err) => {
          reject("Database Error:" + err.toString())
        })
      }
      else{
        load_()
      }
    })
  }

  removeWorkspace(w) {
    return new Promise((resolve, reject)=>{
      if (this.workspace_list.includes(w)) {
        const index = this.workspace_list.indexOf(w)
        this.workspace_list.splice(index, 1)
        this.config_db.get('workspace_list').then((doc) => {
          this.config_db.put({
            _id: doc._id,
            _rev: doc._rev,
            list: this.workspace_list,
            default: 'default'
          }).then(()=>{
            resolve()
            if(this.selected_workspace === w.name){
              this.selected_workspace = null
            }
          }).catch((e)=>{
            reject(`Error occured when removing workspace ${w}: ${e.toString()}`)
          })
        })
        .catch((err) => {
          reject(`Failed to save workspace ${w} database Error: ${err.toString()}`)
        })
      }
    })
  }

  saveWorkflow(joy) {
    // remove if exists
    const name = prompt("Please enter a name for the workflow", "default");
    if (!name) {
      return
    }
    const data = {}
    data.name = name
    data._id = name + '_workflow'
    // delete data._references
    data.workflow = JSON.stringify(joy.top.data)
    this.db.put(data, {
      force: true
    }).then(() => {
      this.workflow_list.push(data)
      this.showMessage(name + ' has been successfully saved.')
    }).catch((err) => {
      this.showMessage('Failed to save the workflow.')
      console.error(err)
    })
  }

  removeWorkflow(w) {
    this.db.get(w._id).then((doc) => {
      return this.db.remove(doc);
    }).then(() => {
      var index = this.workflow_list.indexOf(w);
      if (index > -1) {
        this.workflow_list.splice(index, 1);
      }
      this.showMessage(name + ' has been successfully removed.')
    }).catch((err) => {
      this.showMessage('Failed to remove the workflow.')
      console.error(err)
    })
  }

  reloadDB(){
    return new Promise((resolve, reject) => {
      try {
        if(this.db){
          try {
              this.db.close().finally(()=>{
                this.db = new PouchDB(this.selected_workspace + '_workspace', {
                  revs_limit: 2,
                  auto_compaction: true
                })
                if(this.db){
                  resolve()
                }
                else{
                  reject('Failed to reload database.')
                }
              })
          } catch (e) {
            console.error('failed to reload database: ', e)
            this.db = new PouchDB(this.selected_workspace + '_workspace', {
              revs_limit: 2,
              auto_compaction: true
            })
            if(this.db){
              resolve()
            }
            else{
              reject('Failed to reload database.')
            }
          }
        }
        else{
          this.db = new PouchDB(this.selected_workspace + '_workspace', {
            revs_limit: 2,
            auto_compaction: true
          })
          if(this.db){
            resolve()
          }
          else{
            reject('Failed to reload database.')
          }
        }
      } catch (e) {
        console.error('Failed to reload database.')
        reject('Failed to reload database.')
      }
    })
  }

  setInputLoaders(input_loaders){
    for(let inputs of input_loaders){
      this.wm.registered_inputs[inputs.loader_key] = inputs
      this.wm.registered_loaders[inputs.loader_key] = inputs.loader
    }
  }

  getDefaultInputLoaders(){
    const image_loader = (file)=>{
      const reader = new FileReader();
      reader.onload =  () => {
        this.createWindow(null, {
          name: file.name,
          type: 'imjoy/image',
          data: {src: reader.result, _file: file}
        })
      }
      reader.readAsDataURL(file);
    }

    return [
      {plugin_name: '__internel__', loader_key:'Image',  schema: ajv.compile({properties: {type: {type:"string", "enum": ['image/jpeg', 'image/png', 'image/gif']}, size: {type: 'number'}}, required: ["type", "size"]}), loader: image_loader},
    ]
  }

  reloadPlugins() {
    return new Promise((resolve, reject) => {
      if (this.plugins) {
        for (let k in this.plugins) {
          if (this.plugins.hasOwnProperty(k)) {
            const plugin = this.plugins[k]
            if (typeof plugin.terminate === 'function') {
              try {
                plugin.terminate()
              } catch (e) {
                console.error(e)
              }
            }
            this.plugins[k] = null
            this.plugin_names[plugin.name] = null
          }
        }
      }
      this.resetPlugins()
      this.reloadDB().then(()=>{
        this.db.allDocs({
          include_docs: true,
          attachments: true,
          sort: 'name'
        }).then((result) => {
          this.workflow_list = []
          this.installed_plugins = []
          for (let i = 0; i < result.total_rows; i++) {
            const config = result.rows[i].doc
            if (config.workflow) {
              this.workflow_list.push(config)
            } else {
              config.installed = true
              this.installed_plugins.push(config)
              this.reloadPlugin(config).catch((e)=>{
                console.error(config, e)
                if(!e.toString().includes('Please connect to the Plugin Engine 🚀.')){
                    this.showMessage(`<${config.name}>: ${e.toString()}`)
                }
              })
            }
          }
          resolve()
        }).catch((err) => {
          console.error(err)
          reject()
        });
      })
    })
  }

  async getPluginFromUrl(uri, scoped_plugins){
    scoped_plugins = scoped_plugins || this.available_plugins
    let selected_tag
    if(uri.includes('github') && uri.includes('/blob/')){
      uri = githubUrlRaw(uri)
    }
    // if the uri format is REPO_NAME:PLUGIN_NAME
    if(!uri.startsWith('http') && uri.includes('/') && uri.includes(':')){
      let [repo_name, plugin_name] = uri.split(':')
      selected_tag = plugin_name.split('@')[1]
      plugin_name = plugin_name.split('@')[0]
      plugin_name = plugin_name.trim()
      const repo_hashtag = repo_name.split('@')[1]
      repo_name = repo_name.split('@')[0]
      repo_name = repo_name.trim()
      assert(repo_name && plugin_name, 'Wrong URI format, it must be "REPO_NAME:PLUGIN_NAME"')
      const manifest = await this.getRepoManifest(repo_name, repo_hashtag)
      let found = null
      for(let p of manifest.plugins){
        if(p.name === plugin_name){
          found = p
          break
        }
      }
      if(!found){
        throw(`plugin not found ${repo_name}:${plugin_name}`)
      }
      uri = found.uri
      scoped_plugins = manifest.plugins
    }
    else if(!uri.match(url_regex)){
      let dep = uri.split('@')
      selected_tag = dep[1]
      const ps = scoped_plugins.filter((p) => {
        return dep[0] && p.name === dep[0].trim()
      });
      if (ps.length <= 0) {
        throw `Plugin "${dep[0]}" cannot be found in the repository.`
      }
      else{
        uri = ps[0].uri
      }
    }
    else{
      selected_tag = uri.split('.imjoy.html@')[1]
      if(selected_tag){
        uri = uri.split('@'+selected_tag)[0]
      }
    }
    if(!uri.split('?')[0].endsWith('.imjoy.html')){
      throw 'Plugin url must be ends with ".imjoy.html"'
    }
    const response = await axios.get(uri)
    if (!response || !response.data || response.data === '') {
      alert('failed to get plugin code from ' + uri)
      throw 'failed to get code.'
    }
    const code = response.data
    let config = this.parsePluginCode(code, {tag: selected_tag})
    config.uri = uri
    config.scoped_plugins = scoped_plugins
    return config
  }

  installPlugin(pconfig, tag){
    // pconfig = "oeway/ImJoy-Demo-Plugins:3D Demos"
    return new Promise((resolve, reject) => {
      let uri = typeof pconfig === 'string' ? pconfig : pconfig.uri
      let scoped_plugins = this.available_plugins
      if(pconfig.scoped_plugins){
        scoped_plugins = pconfig.scoped_plugins
        delete pconfig.scoped_plugins
      }
      //use the has tag in the uri if no hash tag is defined.
      if(!uri){
        reject('No url found for plugin ' + pconfig.name)
        return
      }
      // tag = tag || uri.split('@')[1]
      // uri = uri.split('@')[0]

      this.getPluginFromUrl(uri, scoped_plugins).then((config)=>{
        config.origin = pconfig.origin || uri
        if (!config) {
          console.error(`Failed to fetch the plugin from "${uri}".`)
          reject(`Failed to fetch the plugin from "${uri}".`)
          return
        }
        if (!SUPPORTED_PLUGIN_TYPES.includes(config.type)){
          reject('Unsupported plugin type: '+config.type)
          return
        }
        config.tag = tag || config.tag
        if(config.tag){
          // remove existing tag
          const sp = config.origin.split(':')
          if(sp[1]){
            if(sp[1].split('@')[1])
            config.origin = sp[0] + ':' + sp[1].split('@')[0]
          }
          // add a new tag
          config.origin = config.origin + '@' + config.tag
        }
        config._id = config.name && config.name.replace(/ /g, '_') || randId()
        config.dependencies = config.dependencies || []
        const _deps = []
        for (let i = 0; i < config.dependencies.length; i++) {
            _deps.push(this.installPlugin({uri: config.dependencies[i], scoped_plugins: config.scoped_plugins || scoped_plugins}))
        }
        Promise.all(_deps).then(()=>{
          this.savePlugin(config).then((template)=>{
            for (let p of this.available_plugins) {
              if(p.name === template.name && !p.installed){
                p.installed = true
                p.tag = tag
              }
            }
            this.showMessage(`Plugin "${template.name}" has been successfully installed.`)
            resolve()
            this.reloadPlugin(template)
          }).catch(()=>{
            reject(`Failed to save the plugin ${config.name}`)
          })
        }).catch((error)=>{
          alert(`Failed to install dependencies for ${config.name}: ${error}`)
          throw `Failed to install dependencies for ${config.name}: ${error}`
        })

      }).catch((e)=>{
        console.error(e)
        this.showMessage('Failed to download, if you download from github, please use the url to the raw file', 6000)
        reject(e)
      })
    })
  }

  removePlugin(plugin){
    return new Promise((resolve, reject) => {
      // remove if exists
      this.db.get(plugin._id).then((doc) => {
        return this.db.remove(doc);
      }).then(() => {

        for (let i = 0; i < this.installed_plugins.length; i++) {
          if(this.installed_plugins[i].name === plugin.name){
            this.installed_plugins.splice(i, 1)
          }
        }
        for (let p of this.available_plugins) {
            if(p.name === plugin.name){
              p.installed = false
              p.tag = null
            }
        }
        this.unloadPlugin(plugin, true)
        this.showMessage(`"${plugin.name}" has been removed.`)
        resolve()
      }).catch((err) => {
        this.showMessage( err.toString() || "Error occured.")
        console.error('error occured when removing ', plugin, err)
        reject(err)
      });
    });
  }

  getPluginDocs(plugin_id){
    return new Promise((resolve, reject) => {
      this.db.get(plugin_id).then((doc) => {
        const pluginComp = parseComponent(doc.code)
        const docs = pluginComp.docs && pluginComp.docs[0] && pluginComp.docs[0].content
        resolve(docs)
      }).catch((err) => {
        reject(err)
      });
    })
  }

  getPluginSource(plugin_id){
    return new Promise((resolve, reject) => {
      this.db.get(plugin_id).then((doc) => {
        resolve(doc.code)
      }).catch((err) => {
        reject(err)
      });
    })
  }

  unloadPlugin(plugin, temp_remove){
    const name = plugin.name
    for (let k in this.plugins) {
      if (this.plugins.hasOwnProperty(k)) {
        const plugin = this.plugins[k]
        if(plugin.name === name){
            try {
              if(temp_remove){
                delete this.plugins[k]
                delete this.plugin_names[name]
              }
              Joy.remove(name)
              if (typeof plugin.terminate === 'function') {
                plugin.terminate()
              }
            } catch (e) {
              console.error(e)
            }
        }
      }
    }
  }

  reloadPlugin(pconfig) {
    return new Promise((resolve, reject) => {
      try {
        this.unloadPlugin(pconfig, true)
        const template = this.parsePluginCode(pconfig.code, pconfig)
        template._id = pconfig._id
        if(template.type === 'collection'){
          return
        }
        this.unloadPlugin(template, true)
        let p

        if (template.type === 'window') {
          p = this.preLoadPlugin(template)
        } else {
          p = this.loadPlugin(template)
        }
        p.then((plugin) => {
          plugin._id = pconfig._id
          pconfig.name = plugin.name
          pconfig.type = plugin.type
          pconfig.plugin = plugin
          resolve(plugin)
        }).catch((e) => {
          pconfig.plugin = null
          reject(e)
        })
      } catch (e) {
        this.showMessage(e || "Error.", 15000)
        reject(e)
      }
    })
  }

  savePlugin(pconfig) {
    return new Promise((resolve, reject) => {
      const code = pconfig.code
      try {
        const template = this.parsePluginCode(code, {tag: pconfig.tag})
        template.code = code
        template.origin = pconfig.origin
        template._id = template.name.replace(/ /g, '_')
        const addPlugin = () => {
          this.db.put(template, {
            force: true
          }).then(() => {
            for (let i = 0; i < this.installed_plugins.length; i++) {
              if(this.installed_plugins[i].name === template.name){
                this.installed_plugins.splice(i, 1)
              }
            }
            template.installed = true
            this.installed_plugins.push(template)
            resolve(template)
            this.showMessage(`${template.name } has been successfully saved.`)
          }).catch((err) => {
            this.showMessage('Failed to save the plugin.', 15000)
            console.error(err)
            reject('failed to save')
          })
        }
        // remove if exists
        this.db.get(template._id).then((doc) => {
          return this.db.remove(doc);
        }).then(() => {
          addPlugin()
        }).catch(() => {
          addPlugin()
        });
      } catch (e) {
        this.showMessage( e || "Error.", 15000)
        reject(e)
      }
    })
  }

  reloadPythonPlugins(){
    for(let p of this.installed_plugins){
      if(p.type === 'native-python'){
        this.reloadPlugin(p)
      }
    }
  }

  removePythonPlugins(){
    for (let k in this.plugins) {
      if (this.plugins.hasOwnProperty(k)) {
        const plugin = this.plugins[k]
        if(plugin.type === 'native-python'){
          try {
            Joy.remove(plugin.name)
            if (typeof plugin.terminate === 'function') {
              plugin.terminate()
            }
          } catch (e) {

          }
        }
      }
    }
  }

  parsePluginCode(code, config) {
    config = config || {}
    const uri = config.uri
    const tag = config.tag
    const origin = config.origin
    try {
      if (uri && uri.endsWith('.js')) {
        config.lang = config.lang || 'javascript'
        config.script = code
        config.style = null
        config.window = null
        config.tag = tag || null
      } else {
        const pluginComp = parseComponent(code)
        config = JSON.parse(pluginComp.config[0].content)
        config.scripts = []
        for (let i = 0; i < pluginComp.script.length; i++) {
          if (pluginComp.script[i].attrs.lang) {
            config.script = pluginComp.script[i].content
            config.lang = pluginComp.script[i].attrs.lang || 'javascript'
          }
          else{
            config.scripts.push(pluginComp.script[i])
          }
        }
        if(!config.script){
          config.script = pluginComp.script[0].content
          config.lang = pluginComp.script[0].attrs.lang || 'javascript'
        }
        config.tag = tag || config.tags && config.tags[0]
        // try to match the script with current tag
        for (let i = 0; i < pluginComp.script.length; i++) {
          if (pluginComp.script[i].attrs.tag === config.tag) {
            config.script = pluginComp.script[i].content
            config.lang = pluginComp.script[i].attrs.lang || 'javascript'
            break
          }
        }
        config.links = pluginComp.link || null
        config.windows = pluginComp.window || null
        config.styles = pluginComp.style || null
        config.docs = pluginComp.docs || null
        config.attachments = pluginComp.attachment || null
      }
      config._id = config._id || null
      config.uri = uri
      config.origin = origin
      config.code = code
      config.id = config.name.trim().replace(/ /g, '_') + '_' + randId()
      config.runnable = config.runnable === false ? false : true
      for (let i = 0; i < CONFIGURABLE_FIELDS.length; i++) {
          const obj = config[CONFIGURABLE_FIELDS[i]]
          if(obj && typeof obj === 'object' && !(obj instanceof Array)){
            if(config.tag){
              config[CONFIGURABLE_FIELDS[i]] = obj[config.tag]
              if(!obj.hasOwnProperty(config.tag)){
                console.log("WARNING: " + CONFIGURABLE_FIELDS[i] + " do not contain a tag named: " + config.tag)
              }
            }
            else{
              throw "You must use 'tags' with configurable fields."
            }
          }
      }
      config = upgradePluginAPI(config)
      if (!PLUGIN_SCHEMA(config)) {
        const error = PLUGIN_SCHEMA.errors
        console.error("Invalid plugin config: " + config.name, error)
        throw error
      }
      return config
    } catch (e) {
      console.error(e)
      throw "Failed to parse the content of the plugin."
    }
  }

  validatePluginConfig(config){
    if(config.name.indexOf('/')<0){
      return true
    }
    else{
      throw "Plugin name should not contain '/'."
    }
  }

  preLoadPlugin(template, rplugin) {
    const config = {
      name: template.name,
      type: template.type,
      ui: template.ui,
      tag: template.tag,
      inputs: template.inputs,
      outputs: template.outputs,
      _id: template._id
    }
    this.validatePluginConfig(config)
    //generate a random id for the plugin
    return new Promise((resolve, reject) => {
      if(!rplugin){
        config.id = template.name.trim().replace(/ /g, '_') + '_' + randId()
        config.initialized = false
      }
      else{
        config.id = rplugin.id
        config.initialized = true
      }
      const tconfig = _.assign({}, template, config)
      const plugin = {
        _id: config._id,
        id: config.id,
        name: config.name,
        type: config.type,
        config: tconfig,
        docs: template.docs,
        tag: template.tag,
        attachments: template.attachments,
        terminate: function(callback){ this._disconnected = true; if(callback) callback(); }
      }
      this.plugins[plugin.id] = plugin
      this.plugin_names[plugin.name] = plugin
      plugin.api = {
        __jailed_type__: 'plugin_api',
        __id__: plugin.id,
        run: async (my) => {
          const c = _clone(template.defaults) || {}
          c.type = template.name
          c.name = template.name
          c.tag = template.tag
          // c.op = my.op
          c.data = my.data
          c.config = my.config
          await this.createWindow(null, c)
        }
      }
      try {
        this.register(plugin, config)
        resolve(plugin)
      } catch (e) {
        reject(e)
      }
    })
  }

  loadPlugin(template, rplugin) {
    template = _clone(template)
    this.validatePluginConfig(template)
    //generate a random id for the plugin
    return new Promise((resolve, reject) => {
      const config = {}
      if(!rplugin){
        config.id = template.name.trim().replace(/ /g, '_') + '_' + randId()
        config.initialized = false
      }
      else{
        config.id = rplugin.id
        config.initialized = true
      }
      config._id = template._id
      config.context = this.getPluginContext()
      if (template.type === 'native-python') {
        if (!this.em.socket) {
          console.error("Please connect to the Plugin Engine 🚀.")
        }
      }
      const tconfig = _.assign({}, template, config)
      tconfig.workspace = this.selected_workspace
      const plugin = new DynamicPlugin(tconfig, _.assign({TAG: tconfig.tag, WORKSPACE: this.selected_workspace}, this.imjoy_api))
      plugin.whenConnected(() => {
        if (!plugin.api) {
          console.error('Error occured when loading plugin.')
          this.showMessage('Error occured when loading plugin.')
          reject('Error occured when loading plugin.')
          throw 'Error occured when loading plugin.'
        }

        if (template.type) {
          this.register(plugin, template)
        }
        if (template.extensions && template.extensions.length > 0) {
          this.registerExtension(template.extensions, plugin)
        }
        if(plugin.api.setup){
          plugin.api.setup().then(() => {
            this.event_bus.$emit('plugin_loaded', plugin)
            resolve(plugin)
          }).catch((e) => {
            console.error('error occured when loading plugin ' + template.name + ": ", e)
            this.showMessage(`<${template.name}>: ${e}`, 15000)
            reject(e)
            plugin.terminate()
          })
        }
        else{
          this.showMessage(`No "setup()" function is defined in plugin "${plugin.name}".`)
          reject(`No "setup()" function is defined in plugin "${plugin.name}".`)
        }
      });
      plugin.whenFailed((e) => {
        if(e){
          this.showMessage(`<${template.name}>: ${e}`)
        }
        else{
          this.showMessage(`Error occured when loading ${template.name}.`)
        }
        console.error('error occured when loading ' + template.name + ": ", e)
        plugin.terminate()
        reject(e)
      });
      plugin.docs = template.docs
      plugin.attachments = template.attachments
      this.plugins[plugin.id] = plugin
      this.plugin_names[plugin.name] = plugin
    })
  }

  normalizeUI(ui){
    if(!ui){
      return ''
    }
    let normui = ''
    if(Array.isArray(ui)){
      for(let it of ui){
        if(typeof it === 'string')
          normui =  normui + it + '<br>'
        else if(typeof it === 'object'){
          for(let k in it){
            if(typeof it[k] === 'string')
              normui =  normui + k + ': ' + it[k] + '<br>'
            else
              normui =  normui + k + ': ' + JSON.stringify(it[k])+ '<br>'
          }
        }
        else
          normui =  normui + JSON.stringify(it) + '<br>'
      }
    }
    else if(typeof ui === 'object'){
      throw "ui can not be an object, you can only use a string or an array."
    }
    else if(typeof ui === 'string'){
      normui = ui.trim()
    }
    else{
      normui = ''
      console.log('Warining: removing ui string.')
    }
    return normui
  }

  register(plugin, config) {
    try {
      if(!plugin) throw "Plugin not found."
      config = _clone(config)
      config.name = config.name || plugin.name
      config.show_panel = config.show_panel || false
      config.ui = this.normalizeUI(config.ui)
      if(plugin.name === config.name){
        config.ui = config.ui || plugin.config.description
      }
      config.tags = ["op", "plugin"]
      config.inputs = config.inputs || null
      config.outputs = config.outputs || null
      // save type to tags
      if(config.type === 'window'){
        config.tags.push('window')
      }
      else if(config.type === 'native-python'){
        config.tags.push('python')
      }
      else if(config.type === 'web-worker'){
        config.tags.push('web-worker')
      }
      else if(config.type === 'web-python'){
        config.tags.push('web-python')
      }
      else if(config.type === 'iframe'){
        config.tags.push('iframe')
      }
      // use its name for type
      config.type = config.name
      if (!REGISTER_SCHEMA(config)) {
        const error = REGISTER_SCHEMA.errors
        console.error("Error occured during registering " + config.name, error)
        throw error
      }
      let run = null
      if(config.run && typeof config.run === 'function'){
        run = config.run
      }
      else{
        run = plugin && plugin.api && plugin.api.run
      }

      if (!plugin || !run) {
        console.log("WARNING: no run function found in the config, this op won't be able to do anything: " + config.name)
        config.onexecute = () => {
          console.log("WARNING: no run function defined.")
        }
      } else {
        const onexecute = async (my) => {
          // my.target._workflow_id = null;
          const result = await run(this.joy2plugin(my))
          return this.plugin2joy(result)
        }
        config.onexecute = onexecute
      }

      if(config.update && typeof config.update === 'function'){
        const onupdate = async (my) => {
          // my.target._workflow_id = null;
          const result = await config.update(this.joy2plugin(my))
          return this.plugin2joy(result)
        }
        config.onupdate = debounce(onupdate, 300)
      }
      else if(plugin && plugin.api && plugin.api.update){
        const onupdate = async (my) => {
          // my.target._workflow_id = null;
          const result = await plugin.api.update(this.joy2plugin(my))
          return this.plugin2joy(result)
        }
        config.onupdate = debounce(onupdate, 300)
      }
      const joy_template = config

      joy_template.init = joy_template.ui
      Joy.add(joy_template);

      const op_config = {
        plugin_id: plugin.id,
        name: config.name,
        ui: "{id: '__op__', type: '" + config.type + "'}",
        onexecute: config.onexecute
      }
      plugin.ops = plugin.ops || {}
      plugin.ops[config.name] = op_config

      if (config.inputs){
        try {
          if((config.inputs.type != 'object' || !config.inputs.properties) && (config.inputs.type != 'array' || !config.inputs.items)){
            if(typeof config.inputs === 'object'){
              config.inputs = {properties: config.inputs, type: 'object'}
            }
            else{
              throw "inputs schema must be an object."
            }
          }
          // set all the properties as required by default
          if(config.inputs.type === 'object' && config.inputs.properties && !config.inputs.required){
            config.inputs.required = Object.keys(config.inputs.properties)
          }
          const sch = ajv.compile(config.inputs)
          const plugin_name = plugin.name
          const op_name = config.name
          const loader_key = plugin_name+'/'+op_name
          this.wm.registered_inputs[loader_key] =  {loader_key: loader_key, op_name: op_name, plugin_name: plugin_name, schema: sch}
          this.wm.registered_loaders[loader_key] = async (target) => {
              let config = {}
              if (plugin.config && plugin.config.ui) {
                config = await this.imjoy_api.showDialog(plugin.config)
              }
              target.transfer = target.transfer || false
              target._source_op = target._op
              target._op = op_name
              target._workflow_id = target._workflow_id || 'data_loader_'+op_name.trim().replace(/ /g, '_')+randId()
              const my = {op:{name: op_name}, target: target, data: config}
              const result = await plugin.api.run(this.joy2plugin(my))
              if(result){
                const res = this.plugin2joy(result)
                if (res) {
                  const w = {}
                  w.name = res.name || 'result'
                  w.type = res.type || 'imjoy/generic'
                  w.config = res.data
                  w.data = res.target
                  await this.createWindow(plugin, w)
                }
              }
          }

        } catch (e) {
          console.error(`error occured when parsing the inputs schema of "${config.name}"`, e)
        }
      }
      if (config.outputs){
        try {
          if(config.outputs.type != 'object' || !config.outputs.properties){
            if(typeof config.outputs === 'object'){
              config.outputs = {properties: config.outputs, type: 'object'}
            }
            else{
              throw "inputs schema must be an object."
            }
          }
          // set all the properties as required by default
          if(config.outputs.type === 'object' && config.outputs.properties && !config.outputs.required){
            config.outputs.required = Object.keys(config.outputs.properties)
          }
          const sch = ajv.compile(config.outputs)
          this.registered.outputs[plugin.name+'/'+config.name] =  {op_name: config.name, plugin_name: plugin.name, schema: sch}
        } catch (e) {
          console.error(`error occured when parsing the outputs schema of "${config.name}"`, e)
        }
      }

      this.registered.ops[plugin.name+'/'+config.name] = op_config
      this.event_bus.$emit('op_registered', op_config)

      this.registered.windows[config.name] = plugin.config

      return true
    } catch (e) {
      console.error(e)
      throw e
    }

  }

  renderWindow(pconfig) {
    return new Promise((resolve, reject) => {
      const tconfig = _.assign({}, pconfig.plugin, pconfig)
      tconfig.workspace = this.selected_workspace
      const plugin = new DynamicPlugin(tconfig, _.assign({TAG: pconfig.tag, WORKSPACE: this.selected_workspace}, this.imjoy_api))
      plugin.whenConnected(() => {
        if (!plugin.api) {
          console.error('the window plugin seems not ready.')
          reject('the window plugin seems not ready.')
          return
        }
        plugin.api.setup().then(() => {
          //asuming the data._op is passed from last op
          pconfig.data = pconfig.data || {}
          pconfig.data._source_op = pconfig.data && pconfig.data._op
          pconfig.data._op = plugin.name
          pconfig.data._workflow_id = pconfig.data && pconfig.data._workflow_id
          pconfig.plugin = plugin
          pconfig.update = plugin.api.run
          if(plugin.config.runnable && !plugin.api.run){
            const error_text = 'You must define a `run` function for '+plugin.name+' or set its `runnable` field to false.'
            reject(error_text)
            plugin.set_status({type: 'error', text: error_text})
            return
          }
          if(plugin.api.run){
            plugin.api.run(this.filter4plugin(pconfig)).then((result)=>{
              if(result){
                for(let k in result){
                  pconfig[k] = result[k]
                }
              }
              resolve(plugin.api)
            }).catch((e) => {
              console.error('Error in the run function of plugin ' + plugin.name, e)
              plugin.set_status({type: 'error', text: `<${plugin.name}>: (e.toString() || "Error.")`})
              reject(e)
            })
          }
          else{
            resolve(plugin.api)
          }
        }).catch((e) => {
          console.error('Error occured when loading the window plugin ' + pconfig.name + ": ", e)
          plugin.set_status({type: 'error', text: `Error occured when loading the window plugin ${pconfig.name}: ${e.toString()}`})
          plugin.terminate()
          reject(e)
        })
      });
      plugin.whenFailed((e) => {
        console.error('error occured when loading ' + pconfig.name + ":", e)
        plugin.set_status({type: 'error', text:`Error occured when loading ${pconfig.name}: ${e}.`})
        plugin.terminate()
        reject(e)
      });
    })
  }

  //TODO: remove updateWindow from api
  async updateWindow(_plugin, wconfig){
    this.showMessage('Warning: `api.updateWindow` is deprecated, please use the new api.`')
    const w = wconfig.id
    if(w && w.run){
      return await w.run(wconfig)
    }
    else{
      throw `Window (id=${w.id}) not found`
    }
  }

  createWindow(_plugin, wconfig) {
    return new Promise((resolve, reject) => {
      wconfig.config = wconfig.config || {}
      wconfig.data = wconfig.data || null
      wconfig.panel = wconfig.panel || null
      if (!WINDOW_SCHEMA(wconfig)) {
        const error = WINDOW_SCHEMA.errors
        console.error("Error occured during creating window " + wconfig.name, error)
        throw error
      }
      if (wconfig.type && wconfig.type.startsWith('imjoy')) {
        wconfig.id = 'imjoy_'+randId()
        wconfig.name = wconfig.name || 'untitled window'
        this.wm.addWindow(wconfig).then((wid)=>{
          const window_plugin_apis = {
            __jailed_type__: 'plugin_api',
            __id__: wid,
            run: (wconfig)=>{
              const w = this.window_ids[wid]
              for(let k in wconfig){
                w[k] = wconfig[k]
              }
            }
          }
          resolve(window_plugin_apis)
        })
      } else {
        const window_config = this.registered.windows[wconfig.type]
        if (!window_config) {
          console.error('no plugin registered for window type: ', wconfig.type)
          throw 'no plugin registered for window type: ', wconfig.type
        }
        const pconfig = wconfig
        //generate a new window id
        pconfig.type = window_config.type
        pconfig.id = window_config.id + '_' + randId()//window_config.name.trim().replace(/ /g, '_') + '_' + randId()
        if (pconfig.type != 'window') {
          throw 'Window plugin must be with type "window"'
        }
        // this is a unique id for the iframe to attach
        pconfig.iframe_container = 'plugin_window_' + pconfig.id + randId()
        pconfig.iframe_window = null
        pconfig.plugin = window_config
        pconfig.context = this.getPluginContext()


        if (!WINDOW_SCHEMA(pconfig)) {
          const error = WINDOW_SCHEMA.errors
          console.error("Error occured during creating window " + pconfig.name, error)
          throw error
        }
        this.wm.addWindow(pconfig).then(()=>{
          this.renderWindow(pconfig).then((plugin_api)=>{
            resolve(plugin_api)
          }).catch(reject)
        })
      }
    })
  }

  getPluginContext(){
    return {socket: this.em&&this.em.socket}
  }

  async callPlugin(_plugin, plugin_name, function_name) {
    const target_plugin = this.plugin_names[plugin_name]
    if(target_plugin){
      if(!target_plugin.running)
        throw 'plugin "'+plugin_name+ '" is not running.'
      return await target_plugin.api[function_name].apply(null, Array.prototype.slice.call(arguments, 2, arguments.length-1))
    }
    else{
      throw 'plugin with type '+plugin_name+ ' not found.'
    }
  }

  async getPlugin(_plugin, plugin_name) {
    const target_plugin = this.plugin_names[plugin_name]
    if(target_plugin){
      return target_plugin.api
    }
    else{
      throw 'plugin with type '+plugin_name+ ' not found.'
    }
  }

  async runPlugin(_plugin, plugin_name, my) {
    let source_plugin
    if(_plugin && _plugin.id){
      source_plugin = _plugin
    }
    else{
      throw 'source plugin is not available.'
    }
    const target_plugin = this.plugin_names[plugin_name]
    if(target_plugin){
      if(!target_plugin.running)
        throw 'plugin "'+plugin_name+ '" is not running.'
      my = my || {}
      my.op = {type: source_plugin.type, name:source_plugin.name}
      my.config = my.config || {}
      my.data = my.data || {}
      my.data._op = plugin_name
      my.data._source_op = source_plugin.name
      my.data._workflow_id = my.data._workflow_id || null
      my.data._transfer = false
      return await target_plugin.api.run(this.filter4plugin(my))
    }
    else{
      throw 'plugin with type '+plugin_name+ ' not found.'
    }
  }

  plugin2joy(my){
    if(!my) return null
    //conver config--> data  data-->target
    const res = {}

    if(my.type && my.data){
      res.data = my.config
      res.target = my.data
      res.target.name = my.name
      res.target.type = my.type
    }
    else{
      res.data = null
      res.target = my
    }

    res.target = res.target || {}
    if(Array.isArray(res.target) && res.target.length>0){
      if(my.select !== undefined && res.target[my.select]){
        res.target = res.target[my.select]
      }
    }
    if(typeof res.target === 'object'){
      res.target._variables = my._variables || {}
      res.target._workflow_id = my._workflow_id || null
      res.target._op = my._op || null
      res.target._source_op = my._source_op || null
      res.target._transfer = my._transfer || false
      if(Object.keys(res.target).length>4){
        return res
      }
      else{
        return null
      }
    }
    else {
      return res
    }
  }

  filter4plugin(my){
    return my && {
      _variables: my._variables || null,
      _op: my._op,
      _source_op: my._source_op,
      _transfer: my._transfer,
      _workflow_id: my._workflow_id,
      config: my.config,
      data: my.data,
    }
  }

  joy2plugin(my){
    //conver data-->config target--> data
    if(!my) return null;
    const ret = {
      _variables: my.target && my.target._variables || null,
      _op: my.target && my.target._op,
      _source_op: my.target && my.target._source_op,
      _transfer: my.target && my.target._transfer,
      _workflow_id: my.target && my.target._workflow_id,
      config: my.data,
      data: my.target,
      name: my.target && my.target.name,
      type: my.target && my.target.type
    }
    if(my.target){
      delete my.target._op
      delete my.target._workflow_id
      delete my.target._variables
      delete my.target._source_op
      delete my.target._transfer
    }
    return ret
  }

  getRepoManifest(url, hashtag){
    return new Promise((resolve, reject)=>{
      const re = new RegExp('^[^/.]+/[^/.]+$')
      let repository_url
      let repo_origin
      if(url.match(re)){
        repo_origin = url
        if(hashtag){
          url = url + '/tree/'+ hashtag
          repo_origin = repo_origin + '@' + hashtag
        }
        repository_url = githubImJoyManifest('https://github.com/'+url)
      }
      else if(url.includes('github') && url.includes('/blob/')){
        repository_url = githubImJoyManifest(url)
        repo_origin = repository_url
      }
      else{
        repository_url = url
        repo_origin = repository_url
      }
      axios.get(repository_url).then(response => {
        if (response && response.data && response.data.plugins) {
          const manifest = response.data
          manifest.plugins = manifest.plugins.filter((p) => {
            return !p.disabled
          })
          if(!manifest.uri_root.startsWith('http')){
            manifest.uri_root = repository_url.replace(new RegExp('manifest.imjoy.json$'), _.trim(manifest.uri_root, '/'));
          }
          for (let i = 0; i < manifest.plugins.length; i++) {
              const p = manifest.plugins[i]
              p.uri = p.uri || p.name + '.imjoy.html'
              p.origin = repo_origin + ':' + p.name
              if (!p.uri.startsWith(manifest.uri_root) && !p.uri.startsWith('http')) {
                p.uri = manifest.uri_root + '/' + p.uri
              }
              p._id = p._id || p.name.replace(/ /g, '_')
          }
          resolve(manifest)
        }
        else{
          reject('failed to load url: ' + repository_url)
        }
      }).catch(reject)
    })
  }

  setPluginConfig(plugin, name, value){
    if(!plugin) throw "setConfig Error: Plugin not found."
    if(name.startsWith('_') && plugin.config.hasOwnProperty(name.slice(1))){
      throw `'${name.slice(1)}' is a readonly field defined in <config> block, please avoid using it`
    }
    if(value){
      return localStorage.setItem("config_"+plugin.name+'_'+name, value)
    }
    else{
      return localStorage.removeItem("config_"+plugin.name+'_'+name)
    }
  }

  getPluginConfig(plugin, name){
    if(!plugin) throw "getConfig Error: Plugin not found."
    if(name.startsWith('_') && plugin.config.hasOwnProperty(name.slice(1))){
      return plugin.config[name.slice(1)]
    }
    else{
      return localStorage.getItem("config_"+plugin.name+'_'+name)
    }
  }

  getAttachment(plugin, name){
    if(plugin.attachments){
      for (let i = 0; i < plugin.attachments.length; i++) {
        if (plugin.attachments[i].attrs.name === name) {
          return plugin.attachments[i].content
        }
      }
    }
    else{
      return null
    }
  }

  destroy(){
    for (let k in this.plugins) {
      if (this.plugins.hasOwnProperty(k)) {
        const plugin = this.plugins[k]
        try {
          if (typeof plugin.terminate === 'function') plugin.terminate()
        } catch (e) {

        }
      }
    }
  }

}