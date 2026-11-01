-- 04/05周会目录保留每次新增的历史文档，但默认仅最新一份保持confirmed
WITH ranked AS (
  SELECT d.id,
         row_number() OVER (PARTITION BY d.project_id,d.folder_id ORDER BY d.created_at DESC,d.id DESC) AS rn
  FROM documents d
  JOIN knowledge_folders f ON f.id=d.folder_id
  WHERE f.path IN (
    '01-项目管理过程/04-市场拓展&解决方案周会待办事项汇总表',
    '01-项目管理过程/05-项目交付中心周会待办事项汇总表'
  )
  AND d.status NOT IN ('obsolete')
)
UPDATE documents d
SET status='archived',
    metadata=jsonb_set(coalesce(d.metadata,'{}'::jsonb),'{supersededByNewerImport}','true'::jsonb,true),
    updated_at=now()
FROM ranked r
WHERE d.id=r.id AND r.rn>1 AND d.status<>'archived';
