/** Where a project's files live. The editor only ever writes project.json through this (and, when the
 *  person picks one, a background image into `assets/`). */
export interface ProjectStorage {
  readText(path: string): Promise<string>;
  /** A URL a <video>/<audio>/<img> element can load. */
  fileUrl(path: string): string;
  writeProjectJson(text: string): Promise<void>;
  /** Ask for a JPG or PNG and copy it into the project's `assets/` folder. Resolves to the project-relative
   *  path, or null when cancelled; rejects with a sentence to show when the file is refused. */
  pickBackgroundImage?(): Promise<string | null>;
}
