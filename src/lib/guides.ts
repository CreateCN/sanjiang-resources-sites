import { getPublishedGuides, type Guide } from '../server/store';
export { GuideSchema } from './guide-schema';
export type { Guide } from './guide-schema';
export { getPublishedGuides };
export const guidesForResource = (id: string): Guide[] => getPublishedGuides().filter((guide) => guide.resources.includes(id));
