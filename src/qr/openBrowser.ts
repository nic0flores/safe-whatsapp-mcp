// Agent context note: Opens only generated loopback QR URLs in the platform browser without a shell. Tests: test/browser-qr.test.mjs. Keep URLs loopback-only and command arguments shell-free; update this note after meaningful changes.
import { spawn } from "node:child_process";
import process from "node:process";

export interface BrowserLaunchCommand {
  executable: string;
  args: string[];
}

export async function openLocalBrowser(url: string): Promise<boolean> {
  const command = browserLaunchCommand(url);
  if (!command) return false;
  return new Promise((resolve) => {
    const child = spawn(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

export function browserLaunchCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): BrowserLaunchCommand | undefined {
  assertLoopbackUrl(url);
  if (platform === "darwin") return { executable: "open", args: [url] };
  if (platform === "win32") {
    return { executable: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  if (platform === "linux") return { executable: "xdg-open", args: [url] };
  return undefined;
}

function assertLoopbackUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
    throw new Error("Refusing to open a non-loopback QR URL.");
  }
}
