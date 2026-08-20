-- Replication user (used by slave to connect to master)
CREATE USER IF NOT EXISTS 'replicator'@'%' IDENTIFIED BY 'replpass';
GRANT REPLICATION SLAVE ON *.* TO 'replicator'@'%';
FLUSH PRIVILEGES;
