CREATE TRIGGER users_keep_active_owner_on_update
BEFORE UPDATE OF workspace_id, role, status ON users
WHEN OLD.role = 'owner'
 AND OLD.status = 'active'
 AND (
   NEW.workspace_id <> OLD.workspace_id
   OR NEW.role <> 'owner'
   OR NEW.status <> 'active'
 )
 AND NOT EXISTS (
   SELECT 1
     FROM users AS other_owner
    WHERE other_owner.workspace_id = OLD.workspace_id
      AND other_owner.id <> OLD.id
      AND other_owner.role = 'owner'
      AND other_owner.status = 'active'
 )
BEGIN
  SELECT RAISE(ABORT, 'workspace requires an active owner');
END;
