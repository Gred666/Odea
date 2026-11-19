import { cn } from "@/lib/cn";
import { AlertTriangle } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode, useEffect, useState } from "react";
import { version } from "../../package.json";

/* ============================================================
   错误边界（docs/技术方案.md §8.9）：渲染时哪个组件抛了错，只有它所在的那一块换掉，别的照常能用、能存。
   没有它的话 React 把整棵树卸掉，窗口里只剩 body 的底色 —— 白屏，而且一直白下去。

   - window：每种窗口的根上一个（boot/mount.tsx），整个窗口换成「出错了」
   - block：一块区域（列表栏、正文的每个窗格）：这一块出错了 + 错误 + 重试、复制错误信息
   - compact：窄栏那么窄的地方：一个能点的提示图标，点了重试
   - none：浮在上面的（提示条、对话框、弹出窗口、插件的副作用）：不画东西，交给 onError 弹错误提示条。
     它们开没开着记在好几个 store 里，没法统一给 resetKey：等用户下一次点、按键时再试（最多 NONE_RETRIES 次，
     一直坏着的不会每按一个键就弹一次）
   resetKey 变了（换了一篇、换了区）就再试一次

   这个文件不引数据层：启动器、速记小窗的根上也用它，别把仓库窗口的 store 带进去
   ============================================================ */

type Fallback = "window" | "block" | "compact" | "none";

/** none 的那几块自己再试几次（每次等用户点一下、按一个键） */
const NONE_RETRIES = 3;

interface Props {
  /** 哪一块，给人看的名字（「正文」「列表栏」），错误信息里带上 */
  area: string;
  fallback: Fallback;
  /** 变了就再试一次 */
  resetKey?: unknown;
  /** 出错时调一次（仓库窗口里弹错误提示条） */
  onError?: (message: string) => void;
  /** 换掉的那一块的底色（和原来那一块一样，不然露出底下的颜色） */
  className?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string;
}

/** 用户反馈时贴过来就能查的那一段：版本、哪一块、错误和调用栈、组件栈 */
export function errorReport(area: string, error: unknown, componentStack = ""): string {
  const known = error instanceof Error ? error : null;
  return [
    `Odea ${version}（${navigator.userAgent}）`,
    `位置：${area}`,
    `时间：${new Date().toISOString()}`,
    known ? `${known.name}: ${known.message}` : String(error),
    known?.stack ?? "",
    componentStack.trim() && `组件：\n${componentStack.trim()}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: "" };
  /** none：已经自己再试过几次 */
  private retries = 0;
  /** none：等着下一次输入的那个监听，拆掉时摘掉 */
  private stopWaiting: (() => void) | null = null;

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    const componentStack = info.componentStack ?? "";
    this.setState({ componentStack });
    console.error(errorReport(this.props.area, error, componentStack));
    const message = error instanceof Error ? error.message : String(error);
    this.props.onError?.(`${this.props.area}出错了：${message}`);
    if (this.props.fallback === "none" && this.retries < NONE_RETRIES) this.retryOnNextInput();
  }

  override componentWillUnmount() {
    this.stopWaiting?.();
  }

  /** 捕获阶段听：点下去的那个按钮（比如重新打开这个对话框）处理之前就换回来了 */
  private retryOnNextInput() {
    this.stopWaiting?.();
    const retry = () => {
      this.stopWaiting?.();
      this.retries += 1;
      this.reset();
    };
    window.addEventListener("pointerdown", retry, true);
    window.addEventListener("keydown", retry, true);
    this.stopWaiting = () => {
      window.removeEventListener("pointerdown", retry, true);
      window.removeEventListener("keydown", retry, true);
      this.stopWaiting = null;
    };
  }

  override componentDidUpdate(previous: Props) {
    if (this.state.error && !Object.is(previous.resetKey, this.props.resetKey)) this.reset();
  }

  private readonly reset = () => this.setState({ error: null, componentStack: "" });

  override render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    const { area, fallback, className } = this.props;
    const report = () => errorReport(area, error, componentStack);
    switch (fallback) {
      case "none":
        return null;
      case "compact":
        return (
          <div className={cn("flex h-full w-16 shrink-0 flex-col items-center pt-12", className)}>
            <button
              type="button"
              onClick={this.reset}
              title={`${area}出错了：${error.message}。点一下重试`}
              aria-label={`${area}出错了，点一下重试`}
              className="grid h-9 w-9 place-items-center rounded-lg text-danger transition-colors
                         duration-[140ms] hover:bg-raised"
            >
              <AlertTriangle size={16} strokeWidth={2} />
            </button>
          </div>
        );
      case "block":
        return (
          <div
            role="alert"
            className={cn("flex h-full w-full items-center justify-center p-6", className)}
          >
            <div className="w-[360px] max-w-full text-center">
              <AlertTriangle size={18} strokeWidth={2} className="mx-auto text-danger" />
              <p className="mt-2.5 text-[14px] font-semibold text-ink">{area}出错了</p>
              <p
                className="mt-1 line-clamp-3 break-all text-[12px] leading-[1.6] text-muted"
                title={error.message}
              >
                {error.message}
              </p>
              <div className="mt-3.5 flex justify-center gap-2">
                <FallbackButton primary onClick={this.reset}>
                  重试
                </FallbackButton>
                <CopyButton report={report} />
              </div>
            </div>
          </div>
        );
      case "window":
        return (
          <div
            role="alert"
            className={cn(
              "flex h-full w-full items-center justify-center bg-canvas p-8",
              className,
            )}
          >
            <div className="w-[440px] max-w-full">
              <AlertTriangle size={20} strokeWidth={2} className="text-danger" />
              <h1 className="mt-3 text-[17px] font-semibold text-ink">Odea 出错了</h1>
              <p className="mt-1.5 text-[13px] leading-[1.7] text-body">
                这个窗口没能画出来。存过的笔记都在仓库文件夹里；重新载入一般就好了，还不行的话把错误信息复制给我们。
              </p>
              <pre
                className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-raised/50 px-3 py-2
                           font-mono text-[12px] leading-[1.6] text-muted"
              >
                {error.message}
              </pre>
              <div className="mt-4 flex gap-2">
                <FallbackButton primary onClick={() => window.location.reload()}>
                  重新载入
                </FallbackButton>
                <CopyButton report={report} />
              </div>
            </div>
          </div>
        );
    }
  }
}

function FallbackButton({
  primary = false,
  onClick,
  children,
}: {
  primary?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "h-8 shrink-0 rounded-md px-3 text-[13px] font-medium transition-colors duration-[140ms]",
        primary ? "bg-accent text-accent-ink hover:bg-accent-hover" : "text-body hover:bg-raised",
      )}
    >
      {children}
    </button>
  );
}

/** 复制错误信息：复制完字换成「已复制」一会儿 */
function CopyButton({ report }: { report: () => string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    void navigator.clipboard.writeText(report()).then(
      () => setCopied(true),
      (error: unknown) => console.error("复制错误信息失败", error),
    );
  };
  return <FallbackButton onClick={copy}>{copied ? "已复制" : "复制错误信息"}</FallbackButton>;
}
