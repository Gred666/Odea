import { initPreferences } from "@/app/store";
import { CaptureApp } from "@/capture/CaptureApp";
import { mount } from "./mount";

/** 全局快捷键速记的小窗（src-tauri/src/quick_capture.rs）：一个输入框，记一行进今日TODO */
export function boot() {
  initPreferences();
  void mount(<CaptureApp />);
}
