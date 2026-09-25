ALTER TABLE system_alerts ADD COLUMN power_incident_type TEXT CHECK(power_incident_type IN ('scheduled','unscheduled','internal_fault'));
--> statement-breakpoint
ALTER TABLE system_alert_comments ADD COLUMN power_incident_type_after TEXT CHECK(power_incident_type_after IN ('scheduled','unscheduled','internal_fault'));
