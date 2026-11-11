import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres';

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_site_content_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__site_content_v_version_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum_organisation_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__organisation_v_version_status" AS ENUM('draft', 'published');
  CREATE TABLE "site_content" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"home_heading" varchar,
  	"home_intro" varchar,
  	"about_intro" varchar,
  	"about_booking" varchar,
  	"contact_intro" varchar,
  	"legal_privacy_title" varchar,
  	"legal_privacy_description" varchar,
  	"legal_privacy_body" varchar,
  	"legal_terms_title" varchar,
  	"legal_terms_description" varchar,
  	"legal_terms_body" varchar,
  	"legal_cookies_title" varchar,
  	"legal_cookies_description" varchar,
  	"legal_cookies_body" varchar,
  	"legal_accessibility_title" varchar,
  	"legal_accessibility_description" varchar,
  	"legal_accessibility_body" varchar,
  	"seed_version" varchar,
  	"_status" "enum_site_content_status" DEFAULT 'draft',
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  CREATE TABLE "_site_content_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"version_home_heading" varchar,
  	"version_home_intro" varchar,
  	"version_about_intro" varchar,
  	"version_about_booking" varchar,
  	"version_contact_intro" varchar,
  	"version_legal_privacy_title" varchar,
  	"version_legal_privacy_description" varchar,
  	"version_legal_privacy_body" varchar,
  	"version_legal_terms_title" varchar,
  	"version_legal_terms_description" varchar,
  	"version_legal_terms_body" varchar,
  	"version_legal_cookies_title" varchar,
  	"version_legal_cookies_description" varchar,
  	"version_legal_cookies_body" varchar,
  	"version_legal_accessibility_title" varchar,
  	"version_legal_accessibility_description" varchar,
  	"version_legal_accessibility_body" varchar,
  	"version_seed_version" varchar,
  	"version__status" "enum__site_content_v_version_status" DEFAULT 'draft',
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"latest" boolean
  );
  
  CREATE TABLE "organisation_clinicians" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"title" varchar
  );
  
  CREATE TABLE "organisation" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"address" varchar,
  	"phone" varchar,
  	"email" varchar,
  	"hours" varchar,
  	"_status" "enum_organisation_status" DEFAULT 'draft',
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  CREATE TABLE "_organisation_v_version_clinicians" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"title" varchar,
  	"_uuid" varchar
  );
  
  CREATE TABLE "_organisation_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"version_name" varchar,
  	"version_address" varchar,
  	"version_phone" varchar,
  	"version_email" varchar,
  	"version_hours" varchar,
  	"version__status" "enum__organisation_v_version_status" DEFAULT 'draft',
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"latest" boolean
  );
  
  ALTER TABLE "organisation_clinicians" ADD CONSTRAINT "organisation_clinicians_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."organisation"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_organisation_v_version_clinicians" ADD CONSTRAINT "_organisation_v_version_clinicians_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."_organisation_v"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "site_content__status_idx" ON "site_content" USING btree ("_status");
  CREATE INDEX "_site_content_v_version_version__status_idx" ON "_site_content_v" USING btree ("version__status");
  CREATE INDEX "_site_content_v_created_at_idx" ON "_site_content_v" USING btree ("created_at");
  CREATE INDEX "_site_content_v_updated_at_idx" ON "_site_content_v" USING btree ("updated_at");
  CREATE INDEX "_site_content_v_latest_idx" ON "_site_content_v" USING btree ("latest");
  CREATE INDEX "organisation_clinicians_order_idx" ON "organisation_clinicians" USING btree ("_order");
  CREATE INDEX "organisation_clinicians_parent_id_idx" ON "organisation_clinicians" USING btree ("_parent_id");
  CREATE INDEX "organisation__status_idx" ON "organisation" USING btree ("_status");
  CREATE INDEX "_organisation_v_version_clinicians_order_idx" ON "_organisation_v_version_clinicians" USING btree ("_order");
  CREATE INDEX "_organisation_v_version_clinicians_parent_id_idx" ON "_organisation_v_version_clinicians" USING btree ("_parent_id");
  CREATE INDEX "_organisation_v_version_version__status_idx" ON "_organisation_v" USING btree ("version__status");
  CREATE INDEX "_organisation_v_created_at_idx" ON "_organisation_v" USING btree ("created_at");
  CREATE INDEX "_organisation_v_updated_at_idx" ON "_organisation_v" USING btree ("updated_at");
  CREATE INDEX "_organisation_v_latest_idx" ON "_organisation_v" USING btree ("latest");`);
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "site_content" CASCADE;
  DROP TABLE "_site_content_v" CASCADE;
  DROP TABLE "organisation_clinicians" CASCADE;
  DROP TABLE "organisation" CASCADE;
  DROP TABLE "_organisation_v_version_clinicians" CASCADE;
  DROP TABLE "_organisation_v" CASCADE;
  DROP TYPE "public"."enum_site_content_status";
  DROP TYPE "public"."enum__site_content_v_version_status";
  DROP TYPE "public"."enum_organisation_status";
  DROP TYPE "public"."enum__organisation_v_version_status";`);
}
