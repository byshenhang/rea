/**
 * Minimal structural DOM surface used by the Workbench browser UI. The repo
 * compiles with `types: ["node"]` and no lib.dom, so the few browser globals
 * the UI touches are declared here exactly as the code uses them.
 *
 * Deliberately small: anything beyond this surface should stay in the server
 * or be added here explicitly with its shape.
 */

declare global {
  interface HTMLElement {
    readonly dataset: Record<string, string | undefined>;
    innerHTML: string;
    value: string | undefined;
    getAttribute(name: string): string | null;
    addEventListener(
      type: "click",
      listener: (event: MouseEventLike) => void,
    ): void;
    addEventListener(
      type: "keydown",
      listener: (event: KeyboardEventLike) => void,
    ): void;
    addEventListener(
      type: "change",
      listener: (event: EventLike) => void,
    ): void;
    click(): void;
    focus(): void;
  }

  interface HTMLInputElement extends HTMLElement {
    value: string;
  }

  interface HTMLSelectElement extends HTMLElement {
    value: string;
  }

  interface HTMLAnchorElement extends HTMLElement {
    href: string;
    download: string;
  }

  interface EventTargetLike {
    closest<K extends string>(selector: K): HTMLElement | null;
  }

  interface EventLike<T = EventTargetLike> {
    readonly target: T | null;
    preventDefault(): void;
  }

  interface MouseEventLike extends EventLike {
    readonly key?: undefined;
  }

  interface KeyboardEventLike extends EventLike {
    readonly key: string;
  }

  interface MessageEventLike {
    readonly data: string;
  }

  interface EventSourceLike {
    onopen: (() => void) | null;
    onerror: (() => void) | null;
    addEventListener(type: string, listener: (event: never) => void): void;
    close(): void;
  }

  interface EventSourceConstructor {
    new (url: string): EventSourceLike;
  }

  interface DocumentLike {
    getElementById(id: string): HTMLElement | null;
    createElement(tag: "a"): HTMLAnchorElement;
  }

  interface BlobLike {
    readonly size: number;
  }

  interface ResponseLike {
    blob(): Promise<BlobLike>;
  }

  interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  }

  interface CryptoLike {
    randomUUID(): string;
  }

  var document: DocumentLike;
  var EventSource: EventSourceConstructor;
  var crypto: CryptoLike;
  var sessionStorage: StorageLike | undefined;
  var prompt: (message: string, fallback?: string) => string | null;
}

export {};
