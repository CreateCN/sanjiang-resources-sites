import { getPublishedResources, findPublishedResource, listCategories } from '../server/store';
import type { Resource } from './resource-schema';
export { ResourceSchema } from './resource-schema';
export type { Resource } from './resource-schema';
export { getPublishedResources, findPublishedResource };
export function getCategories() { return [{ id: 'all', name: '全部资源' }, ...listCategories()]; }
export const repository = 'https://github.com/CreateCN/sanjiang-resources-sites';
export const categoryName = (id: string) => getCategories().find((category) => category.id === id)?.name ?? '全部资源';
export const getStatusLabel = (resource: Resource) => resource.status === 'verified' ? '官方信息已核对' : '资料待核对';
export function feedbackUrl(resource?: Resource) { return `/feedback/${resource ? `?resource=${encodeURIComponent(resource.id)}` : ''}`; }
