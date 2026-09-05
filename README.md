# dsh-mobile

DSH WebUI 移动端适配插件（**PiUI 翻页器结构**）：窄屏下框架本身就是横向 scroll-snap 翻页器，两页卡片——**半开侧边栏页**（`min(360px, 50vw)`）+ **全宽聊天页**。滑到侧边栏页后聊天卡片仍在右边露出一半（PiUI 同款 overlayWidth 效果），聊天渲染零改动。纯客户端适配，零核心改动——官方 rc.2 发行版直接可用。

## 功能

- **PiUI 翻页器**：≤768px 时三栏框架重排为两页横向 snap 轨道——侧边栏页半开宽（约半个视口），聊天页全宽；**滑到侧边栏页时聊天卡片在右半露出（半边信息流）**，PiUI 同款结构
- **侧边栏始终完整渲染**：窄屏下控制器自动展开 AppFrame 折叠的侧边栏并保持（滑动翻页**不同步状态**）——侧边栏列的内容在聊天全屏时也完整留在 DOM 里，滑回来立即可见，**绝不"滑动才跟着渲染"**
- **同色区分**：侧边栏与信息流同色（平页，无圆角阴影）；**只有信息流是卡片**（16px 圆角 + 阴影 + 细边框），PiUI 同款视觉
- **零逐帧装饰**：翻页纯合成器 scroll-snap 驱动，无 JS 逐帧 transform（旧版卡片翻转每帧重光栅整个会话列图层，手机 GPU 吃不消，已移除）；`prefers-reduced-motion` 下吸附瞬移
- **吸附修正**：滑动停止后自动吸附最近整页（滑不到位自动回弹/修正），永不卡半页
- **安全区与键盘**：`viewport-fit=cover` + safe-area env() 变量 + visualViewport 驱动的 `--dshm-keyboard-inset`；`100dvh` 动态视口
- **原生视觉**：桌面宽度下逐字节等同原生（全部规则以 `<html data-dsh-mobile>` 为作用域，卸载即恢复原样）

## 效果

| 桌面（原生三栏） | 手机（侧边栏半开，聊天露半边） | 手机（聊天全屏） |
|---|---|---|
| ![桌面原生](screenshots/desktop-native.png) | ![侧边栏半开](screenshots/mobile-sidebar-page.png) | ![聊天全屏](screenshots/mobile-chat-page.png) |

## 安装

```sh
git clone https://github.com/dsh-external/dsh-mobile.git
dsh plugin --profile web add link:E:/dev/dsh-mobile
```

重启 `dsh web`，用手机模式（DevTools 设备模拟）或真实手机访问即可。

## 使用

- **初始**：侧边栏半开常驻（左侧平页 + 右侧半边聊天卡片）
- **聊天全屏**：手指向左拖；**回侧边栏**：手指向右拖（跨过中点自动吸附整页）
- **第三页（可选）**：占用 details 槽的插件（如 ThreadTrail）在 `<html>` 上设置
  `data-dshm-details-page` 即把详情列变成聊天页右侧的全宽第三页
  （sidebar | chat | details），聊天页**向左滑**露出；不设置则翻页器保持两页不变
- **桌面不受影响**：≥769px 时框架恢复三栏

## 设计约束（为什么是 CSS + 轻量控制器，而不是替换 root）

- dsh 的 `root` 槽位是框架内建的 `single` 槽，由 ui-layout 独占——插件不能替换 AppFrame（`single slot already has a registration` 直接抛错）
- 因此翻页器直接作用于 **AppFrame 本身**：CSS 把 grid 轨道重排为两页（`min(360px, 50vw) 100% 0`）+ `overflow-x: auto` + `scroll-snap`，控制器只滚动它、镜像页面状态、并在滑动结束后吸附+同步——全部基于稳定 data 属性（`data-sidebar-collapsed` / `data-details-collapsed`，rc.2 与工作区快照一致）与对话骨架的 data 座位，**不依赖任何哈希类名**
- **第三页契约**：AppFrame 的 `computeColumns` 在窄屏下永远把 details 轨道压成 0
  （桌面让步链），但详情列只是视觉关闭、内容从不卸载——所以第三页完全由 CSS 给轨道
  全宽实现，只看 `data-dshm-details-page` opt-in，不读取（也读不到）details 展开状态
- 键盘 inset 依赖 `visualViewport`（现代浏览器/PWA 均有）；不支持时退化为 0

## 开发

```sh
pnpm install        # devDeps: @deepseek-ai/dsh-client-* 取 npm registry（^0.1.2-rc.1，与发行版对齐），无本机路径
pnpm run check      # typecheck + test + build
```

```
src/client/
  index.ts           # 客户端入口：挂载控制器、待处理交互横幅（ctx.uiSession.pendingInteractions）、前台恢复重载
  controller.ts      # DOM 控制器：viewport meta、翻页镜像、键盘 inset、FAB、选会话回聊天页
  mobile.css         # 全局移动端样式表（<style data-plugin> 注入，卸载即移除）
```

## License

BSD-3-Clause



