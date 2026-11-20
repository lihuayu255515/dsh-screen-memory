// 屏幕记忆 · 客户端半边（右侧栏画廊，写操作由服务端 API 控制）
//
// 两种注册方式都尝试，全部包在 try/catch 里：
//   1) 现代 DSH：sidebarRightTabs 注册 tab 类型 + sidebar.right.pane.tab 槽位
//   2) 退化：设置页里加一个「屏幕记忆」入口
// 任何一步失败都静默放弃，不影响宿主插件与其它客户端。
window.__ModuleLoader__.load({
  id: 'dsh-screen-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    let React = null
    try { React = require('react') } catch (e) { React = null }

    const inject = ['slots']
    const TAB_ID = 'dsh-screen-memory-gallery'
    const UI_SRC = '/dsh-screen-memory/ui'

    function Frame() {
      if (!React) return null
      return React.createElement('iframe', {
        src: UI_SRC,
        title: '屏幕记忆',
        style: { width: '100%', height: '100%', border: '0', display: 'block', background: '#0f1115' },
      })
    }

    function apply(ctx) {
      try {
        const slots = ctx.get && ctx.get('slots')
        if (!slots || !React) return

        // ---- 现代 API ----
        if (typeof ctx.inject === 'function') {
          let registered = false
          try {
            ctx.inject(['sidebarRightTabs'], (owner) => {
              try {
                const tabs = owner.get && owner.get('sidebarRightTabs')
                if (!tabs || typeof tabs.register !== 'function' || !owner.slots) return
                owner.effect(() => tabs.register({
                  id: TAB_ID,
                  kind: TAB_ID,
                  priority: 'extension',
                  title: () => '屏幕记忆',
                }))
                owner.slots.inject('sidebar.right.pane.tab', () => owner.slots.register({
                  name: 'sidebar.right.pane.tab',
                  key: TAB_ID,
                  inject: () => ({}),
                }, Frame))
                registered = true
              } catch (e) { /* 静默 */ }
            })
          } catch (e) { /* 静默 */ }
          if (registered) return
        }

        // ---- 退化：设置页入口 ----
        try {
          slots.inject('settings.section', () => slots.register({
            name: 'settings.section',
            id: 'screen-memory',
            order: 52,
            label: () => '屏幕记忆',
          }, Frame))
        } catch (e) { /* 静默 */ }
      } catch (e) { /* 静默 */ }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
