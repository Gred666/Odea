/* ============================================================
   所有单测共用的准备（vite.config.ts 的 test.setupFiles）。

   happy-dom 的 Animation.cancel() 把 finished 那个 promise 拒掉了，却没像浏览器那样把它
   标成「已处理」（Web Animations 规范要求标上）。代码里取消动画、又没人等 finished 的地方
   （动态表情、查找面板、换文档的淡化）一跑，vitest 就记一条 unhandled rejection，
   整轮测试明明全过了也以失败退出。这里照规范补上：取消之前先给它接一个空的 catch。
   ============================================================ */

if (typeof Animation !== "undefined") {
  const cancel = Animation.prototype.cancel;
  Animation.prototype.cancel = function (this: Animation) {
    this.finished?.catch(() => {});
    cancel.call(this);
  };
}
