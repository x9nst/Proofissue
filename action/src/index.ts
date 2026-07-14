import type { ApplicationServices } from '@proofissue/application';

export interface ActionAdapter {
  readonly application: ApplicationServices;
}

export const createActionAdapter = (application: ApplicationServices): ActionAdapter =>
  Object.freeze({ application });
