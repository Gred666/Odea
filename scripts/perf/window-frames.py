# 桌面端窗口出现 / 消失的逐帧抓屏（CLAUDE.md「动效」的验证；docs/仓库与启动器.md §16.2）
#
# 系统层面的窗口动画（关窗、开窗、两个窗口交接）在 WebView 里量不到，只能抓屏幕。Desktop Duplication
# 只在屏幕真的更新时给新帧：每一帧记下时间、窗口左 / 右 / 上边的位置、正中的亮度。
#
# 准备（只在 Windows 上）：
#   python -m venv <临时目录>\venv
#   <临时目录>\venv\Scripts\pip install dxcam numpy pillow
#   pnpm dev 开着；另起一个开发版 —— 换一个 identifier（用户自己的 Odea 开着时，同一个 identifier 的开发版
#   会被单实例转给它）、临时数据目录（config.json 的 vaults 里放一个 "open": false 的仓库，启动就是启动器）、
#   WebView2 调试端口：
#     <临时目录>\tauri.json 写 {"identifier":"dev.odea.frames","build":{"beforeDevCommand":""}}
#     ODEA_DATA_DIR=<临时目录>\data  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9341
#     pnpm tauri dev --config <临时目录>\tauri.json
#
# 用法：
#   <venv>\Scripts\python scripts\perf\window-frames.py close   # 用真鼠标点启动器的 ×（点完鼠标放回原处）
#   <venv>\Scripts\python scripts\perf\window-frames.py open    # 点启动器左边第一个仓库（开着的仓库窗口先关掉）
#   加 --save <目录> 把变了的帧存成 PNG
#
# 坑：
# - 用户的屏上常有别的窗口（聊天窗口）压在前面，抓到的就是别人的东西：启动器后面垫一块纯色、置顶的底板，
#   启动器临时置顶在它上面，只抓启动器那一块（四周带 30px 底板）。退场后露出来的只有底板
# - 量边，不只量亮度：系统的关窗动画边淡边缩（2026-10-29 量到缩放最后一帧跳 11px），只看亮度会以为很顺
# - × 要用真鼠标点：悬停的红底、窗口藏起来那一刻「鼠标离开」都是真的
# - open：启动器、底板放回普通层，新窗口照真实的样子盖在启动器上面
# - 偶尔两帧隔 10ms、步子翻倍，可能是抓屏线程自己漏取了一次：多抓几次再下结论
# - Chrome trace 的 ts 和这里的 perf_counter 都是 QPC，同一个时间轴，可以和 Tracing.start 录的 trace 对上
import argparse
import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import sys
import threading
import time

PORT = 9341
SWP = 0x0001 | 0x0002 | 0x0010  # NOSIZE | NOMOVE | NOACTIVATE
TOPMOST, NOTOPMOST, TOP = wt.HWND(-1), wt.HWND(-2), wt.HWND(0)
BACKDROP = (127, 127, 127)
MARGIN = 30

ctypes.windll.shcore.SetProcessDpiAwareness(2)
u = ctypes.windll.user32
k = ctypes.windll.kernel32


def backdrop(x, y, w, h, seconds):
    """单独一个进程：纯色、无边框、置顶的底板"""
    import tkinter as tk

    root = tk.Tk()
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    root.configure(bg="#%02x%02x%02x" % BACKDROP)
    root.geometry(f"{w}x{h}+{x}+{y}")
    root.title("odea-backdrop")
    root.after(int(seconds * 1000), root.destroy)
    root.mainloop()


def cdp(expression, match="launcher"):
    """在 url 含 match 的页面（没有就随便一个页面）里跑一段 JS"""
    script = f"""
const pages = await (await fetch('http://127.0.0.1:{PORT}/json/list')).json();
const page = pages.find((p) => p.url.includes({json.dumps(match)})) ?? pages.find((p) => p.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({{ id: 1, method: 'Runtime.evaluate', params: {{ expression: {json.dumps(expression)}, awaitPromise: true }} }}));
await new Promise((r) => (ws.onmessage = r));
process.exit(0);
"""
    subprocess.run(["node", "--input-type=module", "-e", script], check=True)


def pages():
    script = f"const p = await (await fetch('http://127.0.0.1:{PORT}/json/list')).json(); console.log(JSON.stringify(p.map((x) => x.url)));"
    out = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def exe_of(hwnd):
    pid = wt.DWORD()
    u.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    handle = k.OpenProcess(0x1000, False, pid.value)
    buf = ctypes.create_unicode_buffer(1024)
    size = wt.DWORD(1024)
    k.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size))
    k.CloseHandle(handle)
    return buf.value


def find_launcher():
    """开发版的启动器：标题 Odea、800 宽（仓库窗口是最大化的）"""
    found = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def each(hwnd, _):
        rect = wt.RECT()
        u.GetWindowRect(hwnd, ctypes.byref(rect))
        title = ctypes.create_unicode_buffer(256)
        u.GetWindowTextW(hwnd, title, 256)
        if (
            u.IsWindowVisible(hwnd)
            and title.value == "Odea"
            and "target\\debug\\odea.exe" in exe_of(hwnd)
            and rect.right - rect.left < 1000
        ):
            found.append(hwnd)
        return True

    u.EnumWindows(each, 0)
    return found[0] if found else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["close", "open"])
    parser.add_argument("--seconds", type=float, default=None)
    parser.add_argument("--save")
    args = parser.parse_args()
    seconds = args.seconds or (1.2 if args.action == "close" else 3.0)

    import dxcam
    import numpy as np

    if args.action == "open" and any("launcher" not in url for url in pages()):
        # 先回到「启动器开着、仓库没开」
        vault = next(url for url in pages() if "launcher" not in url)
        cdp("window.__TAURI_INTERNALS__.invoke('launcher_show')", vault)
        time.sleep(1.5)
        cdp("window.__TAURI_INTERNALS__.invoke('win_close')", vault)
        time.sleep(1.5)
    else:
        cdp("window.__TAURI_INTERNALS__.invoke('launcher_show')", "1420")
    hwnd = None
    for _ in range(100):
        time.sleep(0.1)
        hwnd = find_launcher()
        if hwnd:
            break
    assert hwnd, "启动器没出来"
    time.sleep(0.8)
    rect = wt.RECT()
    ctypes.windll.dwmapi.DwmGetWindowAttribute(hwnd, 9, ctypes.byref(rect), ctypes.sizeof(rect))
    m = 2 * MARGIN
    board = subprocess.Popen(
        [sys.executable, __file__, "--backdrop", str(rect.left - m), str(rect.top - m),
         str(rect.right - rect.left + 2 * m), str(rect.bottom - rect.top + 2 * m), str(seconds + 4)]
    )
    time.sleep(1.0)
    u.SetWindowPos(hwnd, TOPMOST, 0, 0, 0, 0, SWP)
    time.sleep(0.3)
    if args.action == "open":
        u.SetWindowPos(u.FindWindowW(None, "odea-backdrop"), NOTOPMOST, 0, 0, 0, 0, SWP)
        u.SetWindowPos(hwnd, NOTOPMOST, 0, 0, 0, 0, SWP)
        u.SetWindowPos(hwnd, TOP, 0, 0, 0, 0, SWP)
        time.sleep(0.3)
    region = (rect.left - MARGIN, rect.top - MARGIN, rect.right + MARGIN, rect.bottom + MARGIN)

    camera = dxcam.create(output_color="BGRA")
    frames = []
    stop = False

    def grab():
        last = None
        while not stop:
            frame = camera.grab(region=region)
            if frame is None or (last is not None and np.array_equal(frame, last)):
                continue
            frames.append((time.perf_counter(), frame[:, :, [2, 1, 0]].copy()))
            last = frame

    worker = threading.Thread(target=grab)
    worker.start()
    time.sleep(0.4)
    center = frames[-1][1][MARGIN + 260 : MARGIN + 300, MARGIN + 450 : MARGIN + 650].astype(float).mean()
    if abs(center - BACKDROP[0]) < 10:
        stop = True
        worker.join()
        board.kill()
        sys.exit("启动器不在画面里（被别的窗口挡住了？），不测了")

    saved = wt.POINT()
    if args.action == "close":
        u.GetCursorPos(ctypes.byref(saved))
        u.SetCursorPos(rect.right - 26, rect.top + 19)
        time.sleep(0.4)  # 悬停的红底出来
        u.mouse_event(0x0002, 0, 0, 0, 0)
        time.sleep(0.06)
        u.mouse_event(0x0004, 0, 0, 0, 0)
    else:
        cdp("document.querySelector('aside button').click()")
    start = time.perf_counter()
    time.sleep(seconds)
    stop = True
    worker.join()
    del camera
    if args.action == "close":
        u.SetCursorPos(saved.x, saved.y)
    if u.IsWindow(hwnd):
        u.SetWindowPos(hwnd, NOTOPMOST, 0, 0, 0, 0, SWP)
    board.kill()

    print(f"{args.action}：变了的帧 {len(frames)} 张（时间从点下去算；边是抓的那一块里的坐标，底板色 {BACKDROP[0]}）")
    print("     时间    间隔   左   右   上    宽  变化  正中亮度")
    width_before = None
    last = None
    for ts, image in frames:
        gray = image.astype(float).mean(axis=2)
        h, w = gray.shape
        row, col = gray[h // 2], gray[:, w // 2]
        lit = lambda v: v - BACKDROP[0] > 4  # noqa: E731
        left = next((x for x in range(w) if lit(row[x])), None)
        right = next((x for x in range(w - 1, -1, -1) if lit(row[x])), None)
        top = next((y for y in range(h) if lit(col[y])), None)
        width = None if left is None else right - left
        step = "" if width is None or width_before is None else f"{width - width_before:+d}"
        gap = "" if last is None else f"{1000 * (ts - last):.1f}"
        mid = gray[h // 2 - 20 : h // 2 + 20, w // 2 - 100 : w // 2 + 100].mean()
        print(f"{1000 * (ts - start):+8.1f}ms {gap:>6} {left!s:>4} {right!s:>4} {top!s:>4} {width!s:>5} {step:>5}  {mid:6.1f}")
        width_before = width if width is not None else width_before
        last = ts
    if args.save:
        from PIL import Image

        os.makedirs(args.save, exist_ok=True)
        for i, (ts, image) in enumerate(frames):
            Image.fromarray(image).save(os.path.join(args.save, f"{i:03d}_{1000 * (ts - start):+06.0f}ms.png"))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--backdrop":
        x, y, w, h = map(int, sys.argv[2:6])
        backdrop(x, y, w, h, float(sys.argv[6]))
    else:
        main()
