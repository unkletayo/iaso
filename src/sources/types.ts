/** Where a run gets its repository and its bug report from. */
export interface Source {
  /** A folder on the host. The sandbox gets a copy; the folder is never changed. */
  repoPath: string;
  /** The bug report, as text. */
  issue: string;
  /** Short name for logs and the report, e.g. `acme/widgets#7`. */
  label: string;
  /** The issue's web address, when it has one. */
  issueUrl?: string;
  /** The commit the run starts from, when known. */
  commit?: string;
  /** Remove anything the source created on the host. Safe to call twice. */
  cleanup(): Promise<void>;
}
