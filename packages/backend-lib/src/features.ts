import { Static } from "@sinclair/typebox";
import { and, eq, inArray, SQL } from "drizzle-orm";
import {
  schemaValidate,
  schemaValidateWithErr,
} from "isomorphic-lib/src/resultHandling/schemaValidation";
import { omit } from "remeda";

import {
  startComputePropertiesWorkflow,
  terminateComputePropertiesWorkflow,
} from "./computedProperties/computePropertiesWorkflow/lifecycle";
import config from "./config";
import { db } from "./db";
import { feature as dbFeature } from "./db/schema";
import logger from "./logger";
import {
  FeatureConfigByType,
  FeatureMap,
  FeatureName,
  FeatureNamesEnum,
  Features,
  GetWhiteLabelSettingsResponse,
  UpsertWhiteLabelRequest,
  WhiteLabelFeatureConfig,
} from "./types";

export async function getFeature({
  name,
  workspaceId,
}: {
  workspaceId: string;
  name: FeatureName;
}): Promise<boolean> {
  const { useGlobalComputedProperties } = config();
  if (
    name === FeatureNamesEnum.ComputePropertiesGlobal &&
    useGlobalComputedProperties !== undefined
  ) {
    return useGlobalComputedProperties;
  }
  const feature = await db().query.feature.findFirst({
    where: and(
      eq(dbFeature.workspaceId, workspaceId),
      eq(dbFeature.name, name),
    ),
  });
  return feature?.enabled ?? false;
}

export async function getFeatureConfig<T extends FeatureName>({
  name,
  workspaceId,
}: {
  workspaceId: string;
  name: T;
}): Promise<Static<(typeof FeatureConfigByType)[T]> | null> {
  const feature = await db().query.feature.findFirst({
    where: and(
      eq(dbFeature.workspaceId, workspaceId),
      eq(dbFeature.name, name),
    ),
  });
  if (!feature?.enabled) {
    return null;
  }
  const validated = schemaValidateWithErr(
    feature.config,
    FeatureConfigByType[name],
  );
  if (validated.isErr()) {
    logger().error(
      {
        err: validated.error,
        workspaceId,
        name,
        feature,
      },
      "Feature config is not valid",
    );
    return null;
  }
  return validated.value;
}

/**
 * When INSTANCE_WIDE_WHITE_LABEL is enabled, the canonical owner is the
 * lexicographically smallest workspaceId among rows with enabled WhiteLabel.
 */
export async function findCanonicalWhiteLabelOwnerWorkspaceId(): Promise<
  string | null
> {
  const rows = await db().query.feature.findMany({
    where: and(
      eq(dbFeature.name, FeatureNamesEnum.WhiteLabel),
      eq(dbFeature.enabled, true),
    ),
  });
  if (rows.length === 0) {
    return null;
  }
  const sorted = [...rows].sort((a, b) =>
    a.workspaceId.localeCompare(b.workspaceId),
  );
  const canonical = sorted[0];
  if (!canonical) {
    return null;
  }
  if (sorted.length > 1) {
    logger().warn(
      {
        count: sorted.length,
        canonicalWorkspaceId: canonical.workspaceId,
      },
      "Multiple enabled WhiteLabel features; using canonical workspace (min workspace id)",
    );
  }
  return canonical.workspaceId;
}

export function whiteLabelMutationAllowedForTargetWorkspace({
  instanceWideWhiteLabel,
  ownerWorkspaceId,
  targetWorkspaceId,
}: {
  instanceWideWhiteLabel: boolean;
  ownerWorkspaceId: string | null;
  targetWorkspaceId: string;
}): boolean {
  if (!instanceWideWhiteLabel) {
    return true;
  }
  if (ownerWorkspaceId === null) {
    return true;
  }
  return targetWorkspaceId === ownerWorkspaceId;
}

export async function getWhiteLabelSettingsForApi({
  workspaceId,
  requesterIsAdmin,
}: {
  workspaceId: string;
  requesterIsAdmin: boolean;
}): Promise<GetWhiteLabelSettingsResponse> {
  const { instanceWideWhiteLabel } = config();
  const ownerWorkspaceId = instanceWideWhiteLabel
    ? await findCanonicalWhiteLabelOwnerWorkspaceId()
    : null;
  const instanceWideActive =
    instanceWideWhiteLabel && ownerWorkspaceId !== null;

  let effectiveConfig: WhiteLabelFeatureConfig | null;
  if (instanceWideActive && ownerWorkspaceId) {
    effectiveConfig = await getFeatureConfig({
      workspaceId: ownerWorkspaceId,
      name: FeatureNamesEnum.WhiteLabel,
    });
  } else {
    effectiveConfig = await getFeatureConfig({
      workspaceId,
      name: FeatureNamesEnum.WhiteLabel,
    });
  }

  const canEdit =
    requesterIsAdmin &&
    (!instanceWideActive || workspaceId === ownerWorkspaceId);

  return {
    config: effectiveConfig,
    enabled: effectiveConfig !== null,
    instanceWideActive,
    ownerWorkspaceId,
    canEdit,
  };
}

const whiteLabelFieldKeys = [
  "favicon",
  "title",
  "navCardTitle",
  "navCardDescription",
  "navCardIcon",
] as const satisfies readonly (keyof Omit<WhiteLabelFeatureConfig, "type">)[];

export function buildWhiteLabelConfigFromUpsertRequest(
  existing: WhiteLabelFeatureConfig | null,
  body: UpsertWhiteLabelRequest,
): WhiteLabelFeatureConfig {
  let next: WhiteLabelFeatureConfig = {
    type: FeatureNamesEnum.WhiteLabel,
    ...(existing ?? {}),
  };
  for (const key of whiteLabelFieldKeys) {
    if (!(key in body)) {
      continue;
    }
    const v = body[key];
    if (v === "") {
      next = omit(next, [key]);
    } else if (v !== undefined) {
      next[key] = v;
    }
  }
  return next;
}

export async function getFeatures({
  names,
  workspaceId,
}: {
  workspaceId: string;
  names?: FeatureName[];
}): Promise<FeatureMap> {
  const conditions: SQL[] = [eq(dbFeature.workspaceId, workspaceId)];
  if (names) {
    conditions.push(inArray(dbFeature.name, names));
  }
  const features = await db().query.feature.findMany({
    where: and(...conditions),
  });
  const map = features.reduce<FeatureMap>((acc, feature) => {
    const validated = schemaValidate(feature.name, FeatureName);
    if (validated.isErr()) {
      return acc;
    }
    if (!feature.enabled) {
      acc[validated.value] = false;
      return acc;
    }
    if (feature.config && typeof feature.config === "object") {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      acc[validated.value] = feature.config;
      return acc;
    }
    acc[validated.value] = feature.enabled;
    return acc;
  }, {});

  const { instanceWideWhiteLabel } = config();
  const includeWhiteLabel =
    !names || names.includes(FeatureNamesEnum.WhiteLabel);
  if (instanceWideWhiteLabel && includeWhiteLabel) {
    const owner = await findCanonicalWhiteLabelOwnerWorkspaceId();
    if (owner) {
      const wl = await getFeatureConfig({
        workspaceId: owner,
        name: FeatureNamesEnum.WhiteLabel,
      });
      if (wl) {
        map[FeatureNamesEnum.WhiteLabel] = wl;
      } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- drop optional feature key
        delete map[FeatureNamesEnum.WhiteLabel];
      }
    }
  }

  return map;
}

export async function addFeatures({
  workspaceId: workspaceIdInput,
  features,
}: {
  workspaceId: string | string[];
  features: Features;
}) {
  const workspaceIds = Array.isArray(workspaceIdInput)
    ? workspaceIdInput
    : [workspaceIdInput];
  await Promise.all(
    workspaceIds.flatMap((workspaceId) =>
      features.map((feature) =>
        db()
          .insert(dbFeature)
          .values({
            workspaceId,
            name: feature.type,
            enabled: true,
            config: feature,
          })
          .onConflictDoUpdate({
            target: [dbFeature.workspaceId, dbFeature.name],
            set: {
              enabled: true,
              config: feature,
            },
          }),
      ),
    ),
  );

  const effects = workspaceIds.flatMap((workspaceId) =>
    features.flatMap((feature) => {
      switch (feature.type) {
        case FeatureNamesEnum.ComputePropertiesGlobal:
          return terminateComputePropertiesWorkflow({ workspaceId });
        default:
          return [];
      }
    }),
  );
  await Promise.all(effects);
}

export async function removeFeatures({
  workspaceId: workspaceIdInput,
  names,
}: {
  workspaceId: string | string[];
  names: FeatureName[];
}) {
  const workspaceIds = Array.isArray(workspaceIdInput)
    ? workspaceIdInput
    : [workspaceIdInput];
  await db()
    .delete(dbFeature)
    .where(
      and(
        inArray(dbFeature.workspaceId, workspaceIds),
        inArray(dbFeature.name, names),
      ),
    );

  const effects = workspaceIds.flatMap((workspaceId) =>
    names.flatMap((name) => {
      switch (name) {
        case FeatureNamesEnum.ComputePropertiesGlobal:
          return startComputePropertiesWorkflow({ workspaceId });
        default:
          return [];
      }
    }),
  );
  await Promise.all(effects);
}
