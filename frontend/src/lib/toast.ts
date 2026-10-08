/** Show a short message at the bottom of the screen (rendered by <Toast/> in App). */
export function toast(msg: string) {
  window.dispatchEvent(new CustomEvent("comikflix:toast", { detail: msg }));
}
