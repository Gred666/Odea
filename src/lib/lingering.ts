import { useEffect, useState } from "react";

/** on 持续超过 delay 才变成 true；一变回 false 立刻跟着变（快的事情不露「正在…」，免得闪一下） */
export function useLingering(on: boolean, delay: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [on, delay]);
  return shown;
}
