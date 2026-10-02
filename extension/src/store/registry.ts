/**
 * 图片注册表 —— 存放**不可序列化**的运行时对象。
 *
 * 为什么不放进 Redux：`PageImage` 持有 `HTMLImageElement` 与 `Blob`，都是
 * 非可序列化值。塞进 store 会同时污染三件事 —— Redux DevTools 的时间旅行、
 * 状态比较的性能、以及「状态即快照」这个前提。
 *
 * 因此切分：**Redux 只存可序列化的 key 与状态**；元素、字节、快照坐标都放这里。
 * 面板与 content script 通过 key 取用。
 */

import type { PageImage } from '../collectImages';

/** 抓取到的原图字节（跨域抓图由 background 完成后回填） */
export interface FetchedBlob {
  key: string;
  blob: Blob;
  /** 内容类型，用于 multipart 的 filename 扩展名（服务端仍以字节嗅探为准） */
  contentType: string;
  bytes: number;
}

class ImageRegistry {
  private images = new Map<string, PageImage>();
  private blobs = new Map<string, FetchedBlob>();
  /** key → 页面序号（面板分页用，1 起） */
  private pageOf = new Map<string, number>();

  /** 用一次抓取结果整体替换注册表（重新扫描时调用） */
  replace(list: readonly PageImage[], perPage: number): void {
    this.images.clear();
    this.blobs.clear();
    this.pageOf.clear();
    const ordered = [...list];
    ordered.forEach((img, i) => {
      this.images.set(img.key, img);
      this.pageOf.set(img.key, Math.floor(i / perPage) + 1);
    });
  }

  get(key: string): PageImage | undefined {
    return this.images.get(key);
  }

  all(): PageImage[] {
    return [...this.images.values()];
  }

  keys(): string[] {
    return [...this.images.keys()];
  }

  pageOfKey(key: string): number {
    return this.pageOf.get(key) ?? 1;
  }

  /** 已抓取的字节 */
  setBlob(entry: FetchedBlob): void {
    this.blobs.set(entry.key, entry);
  }

  getBlob(key: string): FetchedBlob | undefined {
    return this.blobs.get(key);
  }

  blobCount(): number {
    return this.blobs.size;
  }

  /** 元素引用可能因页面变动失效，取用时必须复核 `isConnected` */
  elementOf(key: string): HTMLImageElement | undefined {
    return this.images.get(key)?.element;
  }

  clear(): void {
    this.images.clear();
    this.blobs.clear();
    this.pageOf.clear();
  }
}

export const registry = new ImageRegistry();
