import { useEffect, useState } from "react";
import { getPlatform } from "./backend";

// Asked once and shared, since several panel sections need it.
let request: Promise<string> | undefined;
let known: string | undefined;

// Python's sys.platform on the machine running Decky, once the backend answers.
export function usePlatform() {
  const [platform, setPlatform] = useState(known);
  useEffect(() => {
    if (known) return;
    request ??= getPlatform();
    request
      .then((p) => setPlatform((known = p)))
      .catch(() => {
        request = undefined; // ask again next time
      });
  }, []);
  return platform;
}

// On Windows, Decky runs in Big Picture, which never shows the Discord view.
export const useIsWindows = () => usePlatform() === "win32";
