-- Creates the read-only monitor user on the slave for the dashboard
CREATE USER IF NOT EXISTS 'monitor'@'%' IDENTIFIED BY 'monitorpass';
GRANT REPLICATION CLIENT ON *.* TO 'monitor'@'%';
FLUSH PRIVILEGES;
