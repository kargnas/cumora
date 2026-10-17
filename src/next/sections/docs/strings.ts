/** Strings for the docs section (keys `docs.*`). */
export const en = {
  'docs.title': 'Documents', 'docs.subtitle': 'Shared notes, edited together.', 'docs.new': 'New document',
  'docs.search': 'Search documents', 'docs.sort': 'Sort', 'docs.sortUpdated': 'Recently edited', 'docs.sortTitle': 'Title',
  'docs.loading': 'Loading documents', 'docs.noMatches': 'No matching documents', 'docs.empty': 'No documents yet',
  'docs.createFirst': 'Create a document', 'docs.untitled': 'Untitled', 'docs.edited': 'Edited', 'docs.delete': 'Delete document',
  'docs.deleteConfirm': 'Delete “{title}”? This cannot be undone.', 'docs.back': 'Back to documents', 'docs.editor': 'Document', 'docs.retry': 'Retry',
} as const
export const zhCN: Partial<Record<keyof typeof en, string>> = {
  'docs.title': '文档', 'docs.subtitle': '共同编辑的共享笔记。', 'docs.new': '新建文档', 'docs.search': '搜索文档', 'docs.sort': '排序',
  'docs.sortUpdated': '最近编辑', 'docs.sortTitle': '标题', 'docs.loading': '正在加载文档', 'docs.noMatches': '没有匹配的文档',
  'docs.empty': '暂无文档', 'docs.createFirst': '创建文档', 'docs.untitled': '未命名', 'docs.edited': '编辑于', 'docs.delete': '删除文档',
  'docs.deleteConfirm': '确定删除“{title}”吗？此操作无法撤销。', 'docs.back': '返回文档列表', 'docs.editor': '文档', 'docs.retry': '重试',
}
