export type Appearance = "light" | "dark";
export function readAppearance(): Appearance | null {
  const value = document.cookie.match(/(?:^|;\s*)nexo-appearance=(dark|light)(?:;|$)/)?.[1];
  return value === "dark" || value === "light" ? value : null;
}
export function saveAppearance(value: Appearance) {
  document.cookie = `nexo-appearance=${value}; Path=/; Max-Age=31536000; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`;
}
export function subscribeSystemAppearance(callback: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}
export const systemIsDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;
