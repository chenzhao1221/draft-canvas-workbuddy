import { parseLocale, serializeTextStyle, type Locale, type TextStyle } from '@draft-canvas/ui';

/** The part of the Web Storage interface this module uses. `window.localStorage` satisfies it. */
export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LOCALE_KEY = 'draft-canvas:v1:locale';
export const TEXT_STYLE_KEY = 'draft-canvas:v1:text-style';
export const DISMISSED_BANNERS_KEY = 'draft-canvas:v1:dismissed-banners';

function defaultStorage(): PrefsStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function read(key: string, storage: PrefsStorage | null): string | null {
  if (storage === null) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string, storage: PrefsStorage | null): void {
  if (storage === null) return;
  try {
    storage.setItem(key, value);
  } catch {
    // The choice then lasts until the panel closes.
  }
}

export function readStoredLocale(storage: PrefsStorage | null = defaultStorage()): Locale | null {
  return parseLocale(read(LOCALE_KEY, storage));
}

export function writeStoredLocale(locale: Locale, storage: PrefsStorage | null = defaultStorage()): void {
  write(LOCALE_KEY, locale, storage);
}

export function readStoredTextStyle(storage: PrefsStorage | null = defaultStorage()): string | null {
  return read(TEXT_STYLE_KEY, storage);
}

export function writeStoredTextStyle(style: TextStyle, storage: PrefsStorage | null = defaultStorage()): void {
  write(TEXT_STYLE_KEY, serializeTextStyle(style), storage);
}

export function readStoredDismissedBanners(storage: PrefsStorage | null = defaultStorage()): string | null {
  return read(DISMISSED_BANNERS_KEY, storage);
}

export function writeStoredDismissedBanners(json: string, storage: PrefsStorage | null = defaultStorage()): void {
  write(DISMISSED_BANNERS_KEY, json, storage);
}
