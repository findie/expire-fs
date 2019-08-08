import {Stats} from "fs";

declare class ExpireEntry {
  constructor({ async, path, parent }: { async?: boolean, path: string, parent: ExpireEntry | null })

  readonly path: string;
  readonly basename: string;
  readonly isDir: boolean;
  readonly isRoot: boolean;

  readonly size: number;
  readonly stats: Stats;
  readonly parent: ExpireEntry | null;
  readonly children: Map<string, ExpireEntry>;
  readonly childrenList: string[];
  readonly hasChildren: boolean;
  readonly childrenValues: ExpireEntry[];

  getTime(type: 'atime' | 'mtime' | 'ctime' | 'birthtime'): number;

  populate(): Promise<void>;

  delete({ keepEmptyParent, dry, removeRoot }?: { keepEmptyParent: boolean, dry: boolean, removeRoot: boolean }): Promise<void>;

  traverse(cb: (e: ExpireEntry) => any): void;

  traverseAsync(cb: (e: ExpireEntry) => Promise<any>): Promise<void>;

  list(): ExpireEntry[]
}

interface ExpireFSConstructorOptions {
  folder: string
  unsafe?: boolean,
  timeType?: 'atime' | 'mtime' | 'ctime' | 'birthtime'
  filter?: RegExp
  expire?: number
  pressure?: number
  minimumAge?: number
  interval?: number
  autoStart?: boolean,
  removeEmptyDirs?: boolean,
  removeCleanedDirs?: boolean,
  removeRoot?: boolean,
  async?: boolean,
  dry?: boolean,
}

declare class ExpireFS {
  private _shouldDelete(path: string, stats: Stats): boolean;

  private _expire({ entry, dry }: { entry: ExpireEntry, dry?: boolean }): Promise<ExpireEntry>;

  private _pressure({ entry, dry }: { entry: ExpireEntry, dry?: boolean }): Promise<ExpireEntry>;

  constructor(props: ExpireFSConstructorOptions);

  list(): Promise<ExpireEntry>;

  clean({ dry }?: { dry: boolean }): Promise<ExpireEntry[]>;

  stop(): boolean;

  start(): boolean;
}


declare namespace ExpireFS {
  const TimeType: {
    access_time: 'atime',
    modify_time: 'mtime',
    creation_time: 'ctime',
    birth_time: 'birthtime'
  }
}


export = ExpireFS