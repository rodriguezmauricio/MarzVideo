/** Where a project's files live. The editor only ever writes project.json through this. */
export interface ProjectStorage {
  readText(path: string): Promise<string>;
  /** A URL a <video>/<audio> element can load. */
  fileUrl(path: string): string;
  writeProjectJson(text: string): Promise<void>;
}
