import { logger } from '@nrwl/devkit';
import { ExecutorContext } from '@nrwl/tao/src/shared/workspace';
import { execFile } from 'child_process';
import { of, throwError } from 'rxjs';
import * as standardVersion from 'standard-version';
import * as changelog from 'standard-version/lib/lifecycles/changelog';

import { callbackify } from 'util';

import version from './';
import { VersionBuilderSchema } from './schema';
import { createFakeContext } from './testing';
import * as git from './utils/git';
import { executePostTargets } from './utils/post-target';
import { tryBump } from './utils/try-bump';
import * as workspace from './utils/workspace';
import { getProjectDependencies } from './utils/get-project-dependencies';

jest.mock('child_process');
jest.mock('standard-version', () => jest.fn());
jest.mock('standard-version/lib/lifecycles/changelog', () => jest.fn());

jest.mock('./utils/git');
jest.mock('./utils/get-project-dependencies');
jest.mock('./utils/try-bump');
jest.mock('./utils/post-target');

describe('@jscutlery/semver:version', () => {
  const mockChangelog = changelog as jest.Mock;
  const mockTryPushToGitRemote = git.tryPushToGitRemote as jest.MockedFunction<
    typeof git.tryPushToGitRemote
  >;
  const mockAddToStage = git.addToStage as jest.MockedFunction<
    typeof git.addToStage
  >;
  const mockTryBump = tryBump as jest.MockedFunction<typeof tryBump>;
  const mockExecFile = execFile as jest.MockedFunction<typeof execFile>;
  const mockStandardVersion = standardVersion as jest.MockedFunction<
    typeof standardVersion
  >;
  const mockGetProjectDependencies = getProjectDependencies as jest.MockedFunction<
    typeof getProjectDependencies
  >;
  const mockExecutePostTargets = executePostTargets as jest.MockedFunction<
    typeof executePostTargets
  >;

  let context: ExecutorContext;

  const options: VersionBuilderSchema = {
    dryRun: false,
    useDeps: false,
    noVerify: false,
    push: false,
    remote: 'origin',
    baseBranch: 'main',
    syncVersions: false,
    skipRootChangelog: false,
    skipProjectChangelog: false,
    postTargets: [],
  };

  beforeEach(() => {
    context = createFakeContext({
      project: 'a',
      projectRoot: '/root/packages/a',
      workspaceRoot: '/root',
      additionalProjects: [
        {project: 'lib1', projectRoot: '/root/libs/lib1'},
        {project: 'lib2', projectRoot: '/root/libs/lib2'},
      ]
    });

    jest.spyOn(logger, 'info');
    jest.spyOn(logger, 'error');

    mockGetProjectDependencies.mockReturnValue(Promise.resolve(['lib1', 'lib2']));
    mockChangelog.mockResolvedValue(undefined);
    mockTryBump.mockReturnValue(of('2.1.0'));

    /* Mock Git execution */
    jest.spyOn(git, 'tryPushToGitRemote').mockReturnValue(of(''));
    jest.spyOn(git, 'addToStage').mockReturnValue(of(''));

    mockExecutePostTargets.mockReturnValue(of(undefined));

    /* Mock a dependency, don't ask me which one. */
    mockExecFile.mockImplementation(
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      callbackify(jest.fn().mockResolvedValue('')) as any
    );

    /* Mock standardVersion. */
    mockStandardVersion.mockResolvedValue(undefined);

    /* Mock console.info. */
    jest.spyOn(console, 'info').mockImplementation();

    /* Mock getPackageFiles. */
    jest
      .spyOn(workspace, 'getPackageFiles')
      .mockReturnValue(
        of(['/root/packages/a/package.json', '/root/packages/b/package.json'])
      );

    /* Mock getProjectRoots. */
    jest
      .spyOn(workspace, 'getProjectRoots')
      .mockReturnValue(of(['/root/packages/a', '/root/packages/b', '/root/libs/lib1', '/root/libs/lib2']));
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('Independent version', () => {
    it('should run standard-version independently on a project', async () => {
      const { success } = await version(options, context);

      expect(success).toBe(true);
      expect(mockTryBump)
        .toBeCalledWith(
          expect.objectContaining({
            dependencyRoots: []
          })
        );
      expect(standardVersion).toBeCalledWith(
        expect.objectContaining({
          silent: false,
          preset: 'angular',
          dryRun: false,
          noVerify: false,
          tagPrefix: 'a-',
          path: '/root/packages/a',
          infile: '/root/packages/a/CHANGELOG.md',
          bumpFiles: ['/root/packages/a/package.json'],
          packageFiles: ['/root/packages/a/package.json'],
        })
      );
    });

    it('should run standard-version independently on a project with dependencies', async () => {
      const tempOptions = {...options, useDeps: true};
      const { success } = await version(tempOptions, context);

      expect(success).toBe(true);
      expect(mockTryBump)
        .toBeCalledWith(
          expect.objectContaining({
            dependencyRoots: ['/root/libs/lib1', '/root/libs/lib2']
          })
        );
      expect(standardVersion).toBeCalledWith(
        expect.objectContaining({
          silent: false,
          preset: 'angular',
          dryRun: false,
          noVerify: false,
          tagPrefix: 'a-',
          path: '/root/packages/a',
          infile: '/root/packages/a/CHANGELOG.md',
          bumpFiles: ['/root/packages/a/package.json'],
          packageFiles: ['/root/packages/a/package.json'],
        })
      );
    });

    it('should run standard-version with a custom tag', async () => {
      const { success } = await version(
        { ...options, versionTagPrefix: 'custom-tag-prefix/${target}-' },
        context
      );

      expect(success).toBe(true);
      expect(standardVersion).toBeCalledWith(
        expect.objectContaining({
          header: expect.any(String),
          dryRun: false,
          tagPrefix: 'custom-tag-prefix/a-',
        })
      );
    });

    it('should not version if no commits since last release', async () => {
      mockTryBump.mockReturnValue(of(undefined));

      const { success } = await version(options, context);

      expect(success).toBe(true);
      expect(logger.info).toBeCalledWith(
        '⏹ Nothing changed since last release.'
      );
      expect(standardVersion).not.toBeCalled();
    });
  });

  describe('Sync versions', () => {
    beforeEach(() => {
      /* With the sync versions, the builder runs on the workspace. */
      context = createFakeContext({
        project: 'workspace',
        projectRoot: '/root',
        workspaceRoot: '/root',
      });
    });

    it('should run standard-version on multiple projects', async () => {
      const { success } = await version(
        {
          ...options,
          /* Enable sync versions. */
          syncVersions: true,
        },
        context
      );

      expect(success).toBe(true);
      expect(changelog).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          header: expect.any(String),
          dryRun: false,
          infile: '/root/packages/a/CHANGELOG.md',
        }),
        '2.1.0'
      );
      expect(changelog).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          header: expect.any(String),
          dryRun: false,
          infile: '/root/packages/b/CHANGELOG.md',
        }),
        '2.1.0'
      );

      expect(standardVersion).toBeCalledWith(
        expect.objectContaining({
          silent: false,
          preset: 'angular',
          dryRun: false,
          noVerify: false,
          path: '/root',
          infile: '/root/CHANGELOG.md',
          bumpFiles: [
            '/root/packages/a/package.json',
            '/root/packages/b/package.json',
          ],
          packageFiles: ['/root/package.json'],
          skip: {
            changelog: false,
          },
        })
      );
    });

    it('should skip root CHANGELOG generation (--skipRootChangelog)', async () => {
      await version(
        {
          ...options,
          syncVersions: true,
          /* Disable root CHANGELOG */
          skipRootChangelog: true,
        },
        context
      );

      expect(standardVersion).toBeCalledWith(
        expect.objectContaining({
          skip: {
            changelog: true,
          },
        })
      );
    });

    it('should skip project CHANGELOG generation (--skipProjectChangelog)', async () => {
      await version(
        {
          ...options,
          syncVersions: true,
          /* Disable project CHANGELOG */
          skipProjectChangelog: true,
        },
        context
      );

      expect(mockChangelog).not.toBeCalled();
      expect(mockAddToStage).toBeCalledWith(
        expect.objectContaining({ paths: [] })
      );
    });

    it('should not version if no commits since last release', async () => {
      mockTryBump.mockReturnValue(of(undefined));

      const { success } = await version(
        {
          ...options,
          syncVersions: true,
        },
        context
      );

      expect(success).toBe(true);

      expect(logger.info).toBeCalledWith(
        '⏹ Nothing changed since last release.'
      );
      expect(standardVersion).not.toBeCalled();
    });

    it('should add files to Git stage only once', async () => {
      await version(
        {
          ...options,
          syncVersions: true,
        },
        context
      );

      expect(mockAddToStage).toBeCalledTimes(1);
      expect(mockAddToStage).toBeCalledWith({
        paths: expect.arrayContaining([
          '/root/packages/a/CHANGELOG.md',
          '/root/packages/b/CHANGELOG.md',
        ]),
        dryRun: false,
      });
    });
  });

  it('should version with --releaseAs', async () => {
    const { success } = await version(
      { ...options, releaseAs: 'major' },
      context
    );
    expect(success).toBe(true);
    expect(mockTryBump).toBeCalledWith(
      expect.objectContaining({
        releaseType: 'major'
      })
    );
    expect(mockStandardVersion).toBeCalledWith(
      expect.objectContaining({ releaseAs: '2.1.0' })
    );
  });

  it('should version with --noVerify', async () => {
    const { success } = await version(
      { ...options, noVerify: true },
      context
    );
    expect(success).toBe(true);
    expect(mockStandardVersion).toBeCalledWith(
      expect.objectContaining({ noVerify: true })
    );
  });

  describe('Git push', () => {
    it('should push to Git', async () => {
      mockTryPushToGitRemote.mockReturnValue(of('success'));

      const { success } = await version({ ...options, push: true }, context);

      expect(success).toBe(true);
      expect(mockTryPushToGitRemote).toHaveBeenCalledWith(
        expect.objectContaining({
          remote: 'origin',
          branch: 'main',
          noVerify: false,
        })
      );
    });

    it('should handle Git failure', async () => {
      mockTryPushToGitRemote.mockReturnValue(
        throwError(() => new Error('Something went wrong'))
      );

      const { success } = await version({ ...options, push: true }, context);

      expect(success).toBe(false);
      expect(logger.error).toBeCalledWith(
        expect.stringContaining('Error: Something went wrong')
      );
    });

    it('should not push to Git by default', async () => {
      await version(options, context);
      expect(mockTryPushToGitRemote).not.toHaveBeenCalled();
    });

    it('should not push to Git when (--dryRun)', async () => {
      await version({ ...options, dryRun: true }, context);
      expect(mockTryPushToGitRemote).not.toHaveBeenCalled();
    });
  });

  describe('Post targets', () => {
    it('should successfully execute post targets', async () => {
      const { success } = await version(
        {
          ...options,
          postTargets: [
            'project-a:test',
            'project-b:test',
            'project-c:test:prod',
          ],
        },
        context
      );

      expect(success).toBe(true);
      expect(mockExecutePostTargets).toBeCalled();
    });

    it('should handle post targets failure', async () => {
      mockExecutePostTargets.mockReturnValue(
        throwError(() => new Error('Nop!'))
      );

      const { success } = await version(
        {
          ...options,
          postTargets: ['project-a:test'],
        },
        context
      );

      expect(success).toBe(false);
      expect(logger.error).toBeCalledWith(expect.stringMatching('Nop!'));
    });

    it('should skip post targets when (--dryRun)', async () => {
      const { success } = await version(
        {
          ...options,
          dryRun: true,
          postTargets: ['project-a:test', 'project-b:test:prod'],
        },
        context
      );

      expect(success).toBe(true);
      expect(mockExecutePostTargets).not.toBeCalled();
    });

    it('should execute post targets after the bump occurred', async () => {
      const { success } = await version(
        {
          ...options,
          postTargets: ['project-a:test'],
        },
        context
      );

      expect(success).toBe(true);
      expect(mockTryBump).toHaveBeenCalledBefore(
        mockExecutePostTargets as jest.Mock
      );
    });

    it('should skip executing post targets if no bump occurred', async () => {
      mockTryBump.mockReturnValue(of(undefined));

      const { success } = await version(
        {
          ...options,
          postTargets: ['project-a:test'],
        },
        context
      );

      expect(success).toBe(true);
      expect(mockExecutePostTargets).not.toBeCalled();
    });
  });
});
