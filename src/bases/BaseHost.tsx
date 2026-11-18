import { Suspense, lazy } from "react";

/* ============================================================
   正文区里开着的一个视图文件（docs/视图文件.md §3.5）。视图本身（表达式、yaml、表格、看板）
   第一次开视图文件时才加载：启动、开笔记都不带它
   ============================================================ */

const BaseView = lazy(() => import("./BaseView"));

export function BaseHost({ relPath }: { relPath: string }) {
  return (
    <Suspense fallback={<div className="h-full w-full bg-canvas" />}>
      <BaseView key={relPath} relPath={relPath} />
    </Suspense>
  );
}
