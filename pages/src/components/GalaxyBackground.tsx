/**
 * GalaxyBackground — 全局动态背景特效
 *
 * 三层视觉:
 *  1) body::before — 流动极光(CSS,始终存在)
 *  2) body::after  — 网格纹理(CSS,始终存在)
 *  3) 本组件       — 浮动光球(React,3个独立动画的模糊圆)
 *
 * 挂载在 Root 层级,所有页面(登录/设置/主界面)都能看到。
 * 颜色跟随 --accent-* 变量,换主题色自动同步。
 */
export function GalaxyBackground() {
  return (
    <div className="galaxy-bg" aria-hidden="true">
      <div className="galaxy-orb galaxy-orb-1" />
      <div className="galaxy-orb galaxy-orb-2" />
      <div className="galaxy-orb galaxy-orb-3" />
    </div>
  );
}
