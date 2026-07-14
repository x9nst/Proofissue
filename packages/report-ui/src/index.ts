import type { ReplayOperationResult } from '@proofissue/contracts';

export interface ReplayReportRenderer {
  render(result: ReplayOperationResult): string;
}
