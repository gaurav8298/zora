import { randomUUID } from "crypto";
import { eq, inArray } from "drizzle-orm";
import { unwrap } from "isomorphic-lib/src/resultHandling/resultUtils";
import {
  FeatureNamesEnum,
  type UpsertWhiteLabelRequest,
  type WhiteLabelFeatureConfig,
} from "isomorphic-lib/src/types";

import config, { type Config } from "./config";
import { db, insert } from "./db";
import { feature as dbFeature, workspace as dbWorkspace } from "./db/schema";
import {
  buildWhiteLabelConfigFromUpsertRequest,
  findCanonicalWhiteLabelOwnerWorkspaceId,
  getFeatures,
  getWhiteLabelSettingsForApi,
  whiteLabelMutationAllowedForTargetWorkspace,
} from "./features";

interface ActualConfigModule {
  default: () => Config;
}

function defaultConfigImplementation(): Config {
  const actualModule: ActualConfigModule = jest.requireActual("./config");
  return actualModule.default();
}

jest.mock("./config", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(defaultConfigImplementation),
}));

// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- jest mock typing
const mockedConfig = config as jest.MockedFunction<typeof config>;
const resetConfigMock = () => {
  mockedConfig.mockImplementation(defaultConfigImplementation);
};

describe("whiteLabelMutationAllowedForTargetWorkspace", () => {
  it("allows any workspace when instance mode is off", () => {
    expect(
      whiteLabelMutationAllowedForTargetWorkspace({
        instanceWideWhiteLabel: false,
        ownerWorkspaceId: "w1",
        targetWorkspaceId: "w2",
      }),
    ).toBe(true);
  });

  it("allows any workspace when instance mode is on but no owner", () => {
    expect(
      whiteLabelMutationAllowedForTargetWorkspace({
        instanceWideWhiteLabel: true,
        ownerWorkspaceId: null,
        targetWorkspaceId: "w2",
      }),
    ).toBe(true);
  });

  it("allows only owner when instance mode is on and owner exists", () => {
    expect(
      whiteLabelMutationAllowedForTargetWorkspace({
        instanceWideWhiteLabel: true,
        ownerWorkspaceId: "w1",
        targetWorkspaceId: "w1",
      }),
    ).toBe(true);
    expect(
      whiteLabelMutationAllowedForTargetWorkspace({
        instanceWideWhiteLabel: true,
        ownerWorkspaceId: "w1",
        targetWorkspaceId: "w2",
      }),
    ).toBe(false);
  });
});

describe("buildWhiteLabelConfigFromUpsertRequest", () => {
  it("merges and clears fields", () => {
    const existing: WhiteLabelFeatureConfig = {
      type: FeatureNamesEnum.WhiteLabel,
      title: "Old",
      favicon: "/old.ico",
    };
    const body: UpsertWhiteLabelRequest = {
      workspaceId: "ws",
      title: "New",
      favicon: "",
    };
    const next = buildWhiteLabelConfigFromUpsertRequest(existing, body);
    expect(next.title).toBe("New");
    expect(next.favicon).toBeUndefined();
  });
});

describe("instance-wide white label in getFeatures", () => {
  const workspaceIdSmall = "00000000-0000-4000-8000-000000000001";
  const workspaceIdLarge = "ffffffff-ffff-4fff-8fff-ffffffffffff";

  beforeEach(() => {
    resetConfigMock();
    mockedConfig.mockImplementation(() => ({
      ...defaultConfigImplementation(),
      instanceWideWhiteLabel: false,
    }));
  });

  afterEach(async () => {
    resetConfigMock();
    await db()
      .delete(dbFeature)
      .where(eq(dbFeature.name, FeatureNamesEnum.WhiteLabel));
    await db()
      .delete(dbWorkspace)
      .where(inArray(dbWorkspace.id, [workspaceIdSmall, workspaceIdLarge]));
  });

  it("uses per-workspace row when instance flag is off", async () => {
    const ws = unwrap(
      await insert({
        table: dbWorkspace,
        values: {
          id: randomUUID(),
          name: `workspace-${randomUUID()}`,
          updatedAt: new Date(),
        },
      }),
    );
    const other = unwrap(
      await insert({
        table: dbWorkspace,
        values: {
          id: randomUUID(),
          name: `workspace-${randomUUID()}`,
          updatedAt: new Date(),
        },
      }),
    );
    const cfg: WhiteLabelFeatureConfig = {
      type: FeatureNamesEnum.WhiteLabel,
      title: "Mine",
    };
    await db().insert(dbFeature).values({
      workspaceId: ws.id,
      name: FeatureNamesEnum.WhiteLabel,
      enabled: true,
      config: cfg,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db()
      .insert(dbFeature)
      .values({
        workspaceId: other.id,
        name: FeatureNamesEnum.WhiteLabel,
        enabled: true,
        config: {
          type: FeatureNamesEnum.WhiteLabel,
          title: "Theirs",
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    const map = await getFeatures({ workspaceId: ws.id });
    expect(map.WhiteLabel).toEqual(cfg);
  });

  it("merges canonical workspace config when instance flag is on", async () => {
    mockedConfig.mockImplementation(() => ({
      ...defaultConfigImplementation(),
      instanceWideWhiteLabel: true,
    }));

    await insert({
      table: dbWorkspace,
      values: {
        id: workspaceIdSmall,
        name: "small",
        updatedAt: new Date(),
      },
    });
    await insert({
      table: dbWorkspace,
      values: {
        id: workspaceIdLarge,
        name: "large",
        updatedAt: new Date(),
      },
    });

    const canonicalConfig: WhiteLabelFeatureConfig = {
      type: FeatureNamesEnum.WhiteLabel,
      title: "Canonical",
    };
    const otherConfig: WhiteLabelFeatureConfig = {
      type: FeatureNamesEnum.WhiteLabel,
      title: "Other",
    };

    await db().insert(dbFeature).values({
      workspaceId: workspaceIdSmall,
      name: FeatureNamesEnum.WhiteLabel,
      enabled: true,
      config: canonicalConfig,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db().insert(dbFeature).values({
      workspaceId: workspaceIdLarge,
      name: FeatureNamesEnum.WhiteLabel,
      enabled: true,
      config: otherConfig,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const owner = await findCanonicalWhiteLabelOwnerWorkspaceId();
    expect(owner).toBe(workspaceIdSmall);

    const mapLarge = await getFeatures({ workspaceId: workspaceIdLarge });
    expect(mapLarge.WhiteLabel).toEqual(canonicalConfig);

    const mapSmall = await getFeatures({ workspaceId: workspaceIdSmall });
    expect(mapSmall.WhiteLabel).toEqual(canonicalConfig);
  });

  it("getWhiteLabelSettingsForApi sets canEdit false for non-owner when instance wide", async () => {
    mockedConfig.mockImplementation(() => ({
      ...defaultConfigImplementation(),
      instanceWideWhiteLabel: true,
    }));

    await insert({
      table: dbWorkspace,
      values: {
        id: workspaceIdSmall,
        name: "small",
        updatedAt: new Date(),
      },
    });
    await insert({
      table: dbWorkspace,
      values: {
        id: workspaceIdLarge,
        name: "large",
        updatedAt: new Date(),
      },
    });

    const canonicalConfig: WhiteLabelFeatureConfig = {
      type: FeatureNamesEnum.WhiteLabel,
      title: "Canonical",
    };

    await db().insert(dbFeature).values({
      workspaceId: workspaceIdSmall,
      name: FeatureNamesEnum.WhiteLabel,
      enabled: true,
      config: canonicalConfig,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const ownerView = await getWhiteLabelSettingsForApi({
      workspaceId: workspaceIdSmall,
      requesterIsAdmin: true,
    });
    expect(ownerView.canEdit).toBe(true);
    expect(ownerView.instanceWideActive).toBe(true);

    const otherView = await getWhiteLabelSettingsForApi({
      workspaceId: workspaceIdLarge,
      requesterIsAdmin: true,
    });
    expect(otherView.canEdit).toBe(false);
    expect(otherView.config).toEqual(canonicalConfig);
  });

  it("does not apply merge when no enabled white label row exists anywhere", async () => {
    mockedConfig.mockImplementation(() => ({
      ...defaultConfigImplementation(),
      instanceWideWhiteLabel: true,
    }));

    const ws = unwrap(
      await insert({
        table: dbWorkspace,
        values: {
          id: randomUUID(),
          name: `workspace-${randomUUID()}`,
          updatedAt: new Date(),
        },
      }),
    );

    const map = await getFeatures({ workspaceId: ws.id });
    expect(map.WhiteLabel).toBeUndefined();
  });
});
