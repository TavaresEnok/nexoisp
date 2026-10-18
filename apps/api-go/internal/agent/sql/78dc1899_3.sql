select n.id as onu_id, n.device_id, n.serial, n.desired_version, n.desired_state as state
         from onus n join devices d on d.id = n.device_id where d.agent_id = $1 and n.desired_version > 0