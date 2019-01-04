import { expect } from 'chai'
import { shallowMount, createLocalVue } from '@vue/test-utils'
import VueRouter from 'vue-router'
import { router_config } from '../src/router'
import Imjoy from '@/components/Imjoy.vue'
import _ from 'lodash'
import {
  // NATIVE_PYTHON_PLUGIN_TEMPLATE,
  WEB_WORKER_PLUGIN_TEMPLATE,
  WEB_PYTHON_PLUGIN_TEMPLATE,
  WINDOW_PLUGIN_TEMPLATE,
} from '../src/api.js'

describe('ImJoy.vue', async () => {
  const localVue = createLocalVue()
  localVue.use(VueRouter)
  const router = new VueRouter(router_config)
  const wrapper = shallowMount(Imjoy, {
    localVue,
    router,
    propsData: {}
  })

  before(function(done) {
    this.timeout(10000)
    wrapper.vm.event_bus.$on('imjoy_ready', ()=>{
      expect(wrapper.vm.plugin_loaded).to.be.true
      done()
    })
  })

  it('should include "Image Processing with Joy!"', async () => {
    expect(wrapper.text()).to.include('Image Processing with Joy!')
  })

  it('should show add plugin dialog', async () => {
    // wrapper.find({ ref: 'add_plugin_button' }).trigger('click')
    wrapper.vm.showPluginManagement()
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.showAddPluginDialog).to.be.true
  })

  it('should create and save the plugin', async () => {
    const old_len = wrapper.vm.windows.length
    const code = _.clone(WEB_WORKER_PLUGIN_TEMPLATE)
    wrapper.vm.newPlugin(code)
    expect(wrapper.vm.windows).to.have.lengthOf(old_len+1)
    const w = wrapper.vm.windows[old_len]
    const pconfig = await w.save({pluginId: w.data._id, code: code, tag: null})
    expect(pconfig.installed).to.be.true
    expect(pconfig.name).to.equal('Untitled Plugin')
  })

  it('should load the new web-worker plugin', async () => {
    const code = _.clone(WEB_WORKER_PLUGIN_TEMPLATE)
    const plugin = await wrapper.vm.reloadPlugin({_id: 'new plugin', tag: null, name:'new plugin', code: code})
    expect(plugin.name).to.equal('Untitled Plugin')
    expect(plugin.type).to.equal('web-worker')
    expect(typeof plugin.api.run).to.equal('function')
    await plugin.api.run({})
  }).timeout(10000)

  it('should load the new window plugin', async () => {
    const code = _.clone(WINDOW_PLUGIN_TEMPLATE)
    const plugin = await wrapper.vm.reloadPlugin({_id: 'new plugin', tag: null, name:'new plugin', code: code})
    expect(plugin.name).to.equal('Untitled Plugin')
    expect(plugin.type).to.equal('window')
    expect(typeof plugin.api.run).to.equal('function')
    await plugin.api.run({})
  }).timeout(10000)

  // it('should load the new native-python plugin', async () => {
  //   const code = _.clone(NATIVE_PYTHON_PLUGIN_TEMPLATE)
  //   const plugin = await wrapper.vm.reloadPlugin({_id: 'new plugin', tag: null, name:'new plugin', code: code})
  //   expect(plugin.name).to.equal('Untitled Plugin')
  //   expect(plugin.type).to.equal('native-python')
  //   expect(typeof plugin.api.run).to.equal('function')
  //   plugin.api.run({})
  // }).timeout(10000)

  it('should load the new web-python plugin', async () => {
    const code = _.clone(WEB_PYTHON_PLUGIN_TEMPLATE)
    const plugin = await wrapper.vm.reloadPlugin({_id: 'new plugin', tag: null, name:'new plugin', code: code})
    expect(plugin.name).to.equal('Untitled Plugin')
    expect(plugin.type).to.equal('web-python')
    expect(typeof plugin.api.run).to.equal('function')
    await plugin.api.run({})
  }).timeout(10000)
})