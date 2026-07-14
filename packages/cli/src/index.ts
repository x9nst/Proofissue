import type { ApplicationServices } from '@proofissue/application';

export interface CliAdapter {
  readonly application: ApplicationServices;
}

export const createCliAdapter = (application: ApplicationServices): CliAdapter =>
  Object.freeze({ application });
