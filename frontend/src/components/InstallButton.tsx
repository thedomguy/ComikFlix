import { useEffect, useState } from "react";
import { toast } from "../lib/toast";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

// Chromium hands us an install prompt via beforeinstallprompt; iOS Safari never does,
// so there the button explains Share -> Add to Home Screen.
const standalone = () =>
  matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches || (navigator as { standalone?: boolean }).standalone === true;
const ios = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

let deferred: BeforeInstallPromptEvent | null = null;
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferred = e as BeforeInstallPromptEvent;
  dispatchEvent(new Event("comikflix:installable"));
});

export function InstallButton() {
  const [show, setShow] = useState(() => !standalone() && (!!deferred || ios()));
  useEffect(() => {
    const on = () => setShow(!standalone());
    const off = () => setShow(false);
    addEventListener("comikflix:installable", on);
    addEventListener("appinstalled", off);
    return () => {
      removeEventListener("comikflix:installable", on);
      removeEventListener("appinstalled", off);
    };
  }, []);
  if (!show) return null;
  return (
    <button
      className="installbtn"
      title="Install Comicflix as an app"
      onClick={async () => {
        if (deferred) {
          await deferred.prompt();
          await deferred.userChoice;
          deferred = null; // single-use; Chromium re-fires beforeinstallprompt if it allows another
          setShow(false);
        } else if (ios()) {
          toast("Tap Share, then “Add to Home Screen”");
        }
      }}
    >
      ⤓ Install
    </button>
  );
}
