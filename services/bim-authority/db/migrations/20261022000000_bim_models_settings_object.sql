-- Models created on first opening (bim.provision_hosted_model before Oct 22 2026)
-- stored their settings JSON-encoded twice: a jsonb string holding the object.
-- The authority now reads either form (readModelSettings); this stores the object.
update bim.models
   set settings = (settings #>> '{}')::jsonb
 where jsonb_typeof(settings) = 'string';

-- New models: settings must be an object from now on.
alter table bim.models
  add constraint bim_models_settings_is_object check (jsonb_typeof(settings) = 'object');
