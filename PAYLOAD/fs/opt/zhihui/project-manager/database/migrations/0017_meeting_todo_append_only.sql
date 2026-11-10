-- 周会待办采用追加式导入：相同文件允许形成新的导入批次，历史完整保留
ALTER TABLE delivery_meeting_todo_imports
  DROP CONSTRAINT IF EXISTS delivery_meeting_todo_imports_checksum_unique;
ALTER TABLE delivery_meeting_todo_imports
  DROP CONSTRAINT IF EXISTS delivery_meeting_todo_imports_checksum_key;
CREATE INDEX IF NOT EXISTS delivery_meeting_todo_imports_checksum_idx
  ON delivery_meeting_todo_imports(checksum);
CREATE INDEX IF NOT EXISTS delivery_meeting_todo_imports_latest_idx
  ON delivery_meeting_todo_imports(imported_at DESC, id DESC);

-- 修复现有项目“01-项目管理过程”下标准目录排序
UPDATE knowledge_folders
SET sort_order = CASE name
  WHEN '01-项目实施计划' THEN 1
  WHEN '02-会议纪要' THEN 2
  WHEN '03-周报与汇报' THEN 3
  WHEN '04-市场拓展&解决方案周会待办事项汇总表' THEN 4
  WHEN '05-项目交付中心周会待办事项汇总表' THEN 5
END,
updated_at = now()
WHERE name IN (
  '01-项目实施计划',
  '02-会议纪要',
  '03-周报与汇报',
  '04-市场拓展&解决方案周会待办事项汇总表',
  '05-项目交付中心周会待办事项汇总表'
)
AND path LIKE '01-项目管理过程/%';
