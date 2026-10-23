import { getPublishedResources, findPublishedResource, findResourceLifecycle, listCategories, listPublishedResourcesIncludingDiscontinued } from '../server/store';
import type { Resource } from './resource-schema';
import { UPSTREAM } from './site-config';
export { ResourceSchema } from './resource-schema';
export type { Resource } from './resource-schema';
export type { ResourceLifecycle } from '../server/store';
export { getPublishedResources, findPublishedResource, findResourceLifecycle, listPublishedResourcesIncludingDiscontinued };
// listCategories() 里若残留历史导入产生的 all 行，不能在书架上重复出现。
export function getCategories() { return [{ id: 'all', name: '全部资源' }, ...listCategories().filter((category) => category.id !== 'all')]; }
export const repository = UPSTREAM.repository;
export const categoryName = (id: string) => getCategories().find((category) => category.id === id)?.name ?? '全部资源';
export const getStatusLabel = (resource: Resource) => resource.status === 'verified' ? '官方信息已核对' : '资料待核对';
export function feedbackUrl(resource?: Resource) { return `/feedback/${resource ? `?resource=${encodeURIComponent(resource.id)}` : ''}`; }
