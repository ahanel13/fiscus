// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A browser's user-agent string in words ("Firefox on Android"), for the signed-in devices list.
 * Best effort: anything unrecognized falls back to "Browser", "Unknown device" when there's none.
 */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /(OPR|Opera)\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /(Chrome|CriOS)\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : /^(curl|Wget)\//i.test(ua)
              ? ua.split('/')[0]!
              : 'Browser';
  const os = /Android/.test(ua)
    ? 'Android'
    : /(iPhone|iPad|iPod)/.test(ua)
      ? 'iOS'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux|X11/.test(ua)
              ? 'Linux'
              : null;
  return os ? `${browser} on ${os}` : browser;
}
