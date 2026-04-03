/* eslint-disable arrow-body-style */
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import { getOrCreateWriteKey, getWriteKeys } from "backend-lib/src/auth";
import backendConfig from "backend-lib/src/config";
import { db, upsert } from "backend-lib/src/db";
import * as schema from "backend-lib/src/db/schema";
import {
  addFeatures,
  buildWhiteLabelConfigFromUpsertRequest,
  findCanonicalWhiteLabelOwnerWorkspaceId,
  getFeatureConfig,
  getWhiteLabelSettingsForApi,
  removeFeatures,
  whiteLabelMutationAllowedForTargetWorkspace,
} from "backend-lib/src/features";
import { upsertEmailProvider } from "backend-lib/src/messaging/email";
import { upsertSmsProvider } from "backend-lib/src/messaging/sms";
import { and, eq } from "drizzle-orm";
import { FastifyInstance } from "fastify";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import {
  BadRequestResponse,
  DataSourceConfigurationResource,
  DataSourceVariantType,
  DefaultEmailProviderResource,
  DefaultSmsProviderResource,
  DeleteDataSourceConfigurationRequest,
  DeleteWhiteLabelRequest,
  DeleteWriteKeyResource,
  EmptyResponse,
  FeatureNamesEnum,
  GetWhiteLabelSettingsRequest,
  GetWhiteLabelSettingsResponse,
  ListDataSourceConfigurationRequest,
  ListDataSourceConfigurationResponse,
  ListWriteKeyRequest,
  ListWriteKeyResource,
  PersistedSmsProvider,
  RoleEnum,
  UpsertDataSourceConfigurationResource,
  UpsertDefaultEmailProviderRequest,
  UpsertEmailProviderRequest,
  UpsertSmsProviderRequest,
  UpsertWhiteLabelRequest,
  UpsertWriteKeyResource,
  WriteKeyResource,
} from "isomorphic-lib/src/types";
import { requireWorkspaceAdmin } from "isomorphic-lib/src/workspaceRoles";

import { denyUnlessAtLeastRole } from "../buildApp/workspaceRoleGuard";

// eslint-disable-next-line @typescript-eslint/require-await
export default async function settingsController(fastify: FastifyInstance) {
  fastify.withTypeProvider<TypeBoxTypeProvider>().get(
    "/white-label",
    {
      schema: {
        description: "Get white-label settings for the workspace",
        tags: ["Settings"],
        querystring: GetWhiteLabelSettingsRequest,
        response: {
          200: GetWhiteLabelSettingsResponse,
        },
      },
    },
    async (request, reply) => {
      const workspace = request.requestContext.get("workspace");
      if (!workspace?.id) {
        return reply.status(403).send();
      }
      if (request.query.workspaceId !== workspace.id) {
        return reply.status(403).send();
      }
      const memberRoles = request.requestContext.get("memberRoles") ?? [];
      const requesterIsAdmin = requireWorkspaceAdmin({
        memberRoles,
        workspaceId: workspace.id,
      }).isOk();
      const payload = await getWhiteLabelSettingsForApi({
        workspaceId: workspace.id,
        requesterIsAdmin,
      });
      return reply.status(200).send(payload);
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().put(
    "/white-label",
    {
      schema: {
        description: "Create or update white-label settings",
        tags: ["Settings"],
        body: UpsertWhiteLabelRequest,
        response: {
          200: GetWhiteLabelSettingsResponse,
          400: BadRequestResponse,
          403: Type.Object({ message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      if (denyUnlessAtLeastRole(request, reply, RoleEnum.Admin)) {
        return;
      }
      const workspace = request.requestContext.get("workspace");
      if (!workspace?.id) {
        return reply.status(403).send();
      }
      if (request.body.workspaceId !== workspace.id) {
        return reply.status(400).send({
          message: "workspaceId does not match the active workspace.",
        });
      }
      const cfg = backendConfig();
      const ownerWorkspaceId = cfg.instanceWideWhiteLabel
        ? await findCanonicalWhiteLabelOwnerWorkspaceId()
        : null;
      if (
        !whiteLabelMutationAllowedForTargetWorkspace({
          instanceWideWhiteLabel: cfg.instanceWideWhiteLabel,
          ownerWorkspaceId,
          targetWorkspaceId: workspace.id,
        })
      ) {
        return reply.status(403).send({
          message:
            "Instance white label is managed from another workspace. Only a workspace Admin there can change it.",
        });
      }
      const existing = await getFeatureConfig({
        workspaceId: workspace.id,
        name: FeatureNamesEnum.WhiteLabel,
      });
      const nextConfig = buildWhiteLabelConfigFromUpsertRequest(
        existing,
        request.body,
      );
      await addFeatures({
        workspaceId: workspace.id,
        features: [nextConfig],
      });
      const memberRoles = request.requestContext.get("memberRoles") ?? [];
      const requesterIsAdmin = requireWorkspaceAdmin({
        memberRoles,
        workspaceId: workspace.id,
      }).isOk();
      const payload = await getWhiteLabelSettingsForApi({
        workspaceId: workspace.id,
        requesterIsAdmin,
      });
      return reply.status(200).send(payload);
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().delete(
    "/white-label",
    {
      schema: {
        description: "Remove white-label settings for the workspace",
        tags: ["Settings"],
        querystring: DeleteWhiteLabelRequest,
        response: {
          204: EmptyResponse,
          403: Type.Object({ message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      if (denyUnlessAtLeastRole(request, reply, RoleEnum.Admin)) {
        return;
      }
      const workspace = request.requestContext.get("workspace");
      if (!workspace?.id) {
        return reply.status(403).send();
      }
      if (request.query.workspaceId !== workspace.id) {
        return reply.status(403).send();
      }
      const cfg = backendConfig();
      const ownerWorkspaceId = cfg.instanceWideWhiteLabel
        ? await findCanonicalWhiteLabelOwnerWorkspaceId()
        : null;
      if (
        !whiteLabelMutationAllowedForTargetWorkspace({
          instanceWideWhiteLabel: cfg.instanceWideWhiteLabel,
          ownerWorkspaceId,
          targetWorkspaceId: workspace.id,
        })
      ) {
        return reply.status(403).send({
          message:
            "Instance white label is managed from another workspace. Only a workspace Admin there can change it.",
        });
      }
      await removeFeatures({
        workspaceId: workspace.id,
        names: [FeatureNamesEnum.WhiteLabel],
      });
      return reply.status(204).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().get(
    "/data-sources",
    {
      schema: {
        description: "Get data source settings",
        tags: ["Settings"],
        querystring: ListDataSourceConfigurationRequest,
        response: {
          200: ListDataSourceConfigurationResponse,
        },
      },
    },
    async (request, reply) => {
      const segmentIoConfiguration =
        await db().query.segmentIoConfiguration.findFirst({
          where: eq(
            schema.segmentIoConfiguration.workspaceId,
            request.query.workspaceId,
          ),
        });
      const existingDatasources: DataSourceVariantType[] = [];
      if (segmentIoConfiguration) {
        existingDatasources.push(DataSourceVariantType.SegmentIO);
      }
      return reply.status(200).send({
        dataSourceConfigurations: existingDatasources,
      });
    },
  );
  fastify.withTypeProvider<TypeBoxTypeProvider>().put(
    "/data-sources",
    {
      schema: {
        description: "Create or update data source settings",
        tags: ["Settings"],
        body: UpsertDataSourceConfigurationResource,
        response: {
          200: DataSourceConfigurationResource,
          400: Type.Object({
            error: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      if (denyUnlessAtLeastRole(request, reply, RoleEnum.WorkspaceManager)) {
        return;
      }
      const { workspaceId, variant } = request.body;

      let resource: DataSourceConfigurationResource;
      switch (variant.type) {
        case DataSourceVariantType.SegmentIO: {
          if (!variant.sharedSecret) {
            return reply.status(400).send({
              error:
                "Invalid payload. Segment variant musti included sharedSecret value.",
            });
          }
          const { id } = await upsert({
            table: schema.segmentIoConfiguration,
            values: {
              workspaceId,
              sharedSecret: variant.sharedSecret,
            },
            target: [schema.segmentIoConfiguration.workspaceId],
            set: {
              sharedSecret: variant.sharedSecret,
            },
          }).then(unwrap);

          resource = {
            id,
            workspaceId,
            variant: {
              type: variant.type,
              sharedSecret: variant.sharedSecret,
            },
          };
        }
      }

      return reply.status(200).send(resource);
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().delete(
    "/data-sources",
    {
      schema: {
        description: "Delete data source settings",
        tags: ["Settings"],
        querystring: DeleteDataSourceConfigurationRequest,
        response: {
          204: EmptyResponse,
        },
      },
    },
    async (request, reply) => {
      if (denyUnlessAtLeastRole(request, reply, RoleEnum.WorkspaceManager)) {
        return;
      }
      const { workspaceId, type } = request.query;
      switch (type) {
        case DataSourceVariantType.SegmentIO: {
          await db()
            .delete(schema.segmentIoConfiguration)
            .where(eq(schema.segmentIoConfiguration.workspaceId, workspaceId));
          break;
        }
      }
      return reply.status(204).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().put(
    "/sms-providers/default",
    {
      schema: {
        description: "Create or update default email provider settings",
        tags: ["Settings"],
        body: DefaultSmsProviderResource,
        response: {
          200: PersistedSmsProvider,
        },
      },
    },
    async (request, reply) => {
      if (denyUnlessAtLeastRole(request, reply, RoleEnum.WorkspaceManager)) {
        return;
      }
      const { workspaceId, smsProviderId } = request.body;

      await upsert({
        table: schema.defaultSmsProvider,
        values: {
          workspaceId,
          smsProviderId,
        },
        target: [schema.defaultSmsProvider.workspaceId],
        set: {
          smsProviderId,
        },
      });

      return reply.status(201).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().put(
    "/email-providers",
    {
      schema: {
        description: "Create or update email provider",
        tags: ["Settings"],
        body: UpsertEmailProviderRequest,
        response: {
          201: EmptyResponse,
          400: BadRequestResponse,
        },
      },
    },
    async (request, reply) => {
      if (denyUnlessAtLeastRole(request, reply, RoleEnum.WorkspaceManager)) {
        return;
      }
      await upsertEmailProvider(request.body);
      return reply.status(201).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().put(
    "/sms-providers",
    {
      schema: {
        description: "Create or update sms provider",
        tags: ["Settings"],
        body: UpsertSmsProviderRequest,
        response: {
          201: EmptyResponse,
          400: BadRequestResponse,
        },
      },
    },
    async (request, reply) => {
      if (denyUnlessAtLeastRole(request, reply, RoleEnum.WorkspaceManager)) {
        return;
      }
      await upsertSmsProvider(request.body);
      return reply.status(201).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().put(
    "/email-providers/default",
    {
      schema: {
        description: "Create or update email provider default",
        tags: ["Settings"],
        body: UpsertDefaultEmailProviderRequest,
        response: {
          201: EmptyResponse,
          400: BadRequestResponse,
        },
      },
    },
    async (request, reply) => {
      if (denyUnlessAtLeastRole(request, reply, RoleEnum.WorkspaceManager)) {
        return;
      }
      const { workspaceId, fromAddress } = request.body;
      let resource: DefaultEmailProviderResource;
      if ("emailProviderId" in request.body) {
        resource = request.body;
      } else {
        const emailProvider = await db().query.emailProvider.findFirst({
          where: and(
            eq(schema.emailProvider.workspaceId, workspaceId),
            eq(schema.emailProvider.type, request.body.emailProvider),
          ),
        });
        if (!emailProvider) {
          return reply.status(400).send({
            message: "Invalid payload. Email provider not found.",
          });
        }
        resource = {
          workspaceId,
          emailProviderId: emailProvider.id,
          fromAddress,
        };
      }

      await upsert({
        table: schema.defaultEmailProvider,
        values: resource,
        target: [schema.defaultEmailProvider.workspaceId],
        set: resource,
      });

      return reply.status(201).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().put(
    "/write-keys",
    {
      schema: {
        description: "Create a write key.",
        tags: ["Settings"],
        body: UpsertWriteKeyResource,
        response: {
          200: WriteKeyResource,
        },
      },
    },
    async (request, reply) => {
      if (denyUnlessAtLeastRole(request, reply, RoleEnum.WorkspaceManager)) {
        return;
      }
      const { workspaceId, writeKeyName } = request.body;

      await getOrCreateWriteKey({
        workspaceId,
        writeKeyName,
      });
      return reply.status(204).send();
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().get(
    "/write-keys",
    {
      schema: {
        description: "Get write keys.",
        tags: ["Settings"],
        querystring: ListWriteKeyRequest,
        response: {
          200: ListWriteKeyResource,
        },
      },
    },
    async (request, reply) => {
      const resource = await getWriteKeys({
        workspaceId: request.query.workspaceId,
      });
      return reply.status(200).send(resource);
    },
  );

  fastify.withTypeProvider<TypeBoxTypeProvider>().delete(
    "/write-keys",
    {
      schema: {
        description: "Delete a write key.",
        tags: ["Settings"],
        body: DeleteWriteKeyResource,
        response: {
          204: EmptyResponse,
        },
      },
    },
    async (request, reply) => {
      if (denyUnlessAtLeastRole(request, reply, RoleEnum.WorkspaceManager)) {
        return;
      }
      const { workspaceId, writeKeyName } = request.body;
      const result = await db()
        .delete(schema.secret)
        .where(
          and(
            eq(schema.secret.workspaceId, workspaceId),
            eq(schema.secret.name, writeKeyName),
          ),
        )
        .returning();
      if (!result.length) {
        return reply.status(404).send();
      }
      return reply.status(204).send();
    },
  );
}
