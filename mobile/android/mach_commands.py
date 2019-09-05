# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

from __future__ import absolute_import, print_function, unicode_literals

import argparse
import logging
import os

import mozpack.path as mozpath

from mozbuild.base import (
    MachCommandBase,
    MachCommandConditions as conditions,
)

from mozbuild.shellutil import (
    split as shell_split,
)

from mach.decorators import (
    CommandArgument,
    CommandProvider,
    Command,
    SubCommand,
)


# Mach's conditions facility doesn't support subcommands.  Print a
# deprecation message ourselves instead.
LINT_DEPRECATION_MESSAGE = """
Android lints are now integrated with mozlint.  Instead of
`mach android {api-lint,checkstyle,findbugs,lint,test}`, run
`mach lint --linter android-{api-lint,checkstyle,findbugs,lint,test}`.
Or run `mach lint`.
"""


# NOTE python/mach/mach/commands/commandinfo.py references this function
#      by name. If this function is renamed or removed, that file should
#      be updated accordingly as well.
def REMOVED(cls):
    """Command no longer exists! Use the Gradle configuration rooted in the top source directory
    instead.

    See https://developer.mozilla.org/en-US/docs/Simple_Firefox_for_Android_build#Developing_Firefox_for_Android_in_Android_Studio_or_IDEA_IntelliJ.  # NOQA: E501
    """
    return False


@CommandProvider
class MachCommands(MachCommandBase):
    @Command('android', category='devenv',
             description='Run Android-specific commands.',
             conditions=[conditions.is_android])
    def android(self):
        pass

    @SubCommand('android', 'assemble-app',
                """Assemble Firefox for Android.
        See http://firefox-source-docs.mozilla.org/build/buildsystem/toolchains.html#firefox-for-android-with-gradle""")  # NOQA: E501
    @CommandArgument('args', nargs=argparse.REMAINDER)
    def android_assemble_app(self, args):
        ret = self.gradle(self.substs['GRADLE_ANDROID_APP_TASKS'] +
                          ['-x', 'lint'] + args, verbose=True)

        return ret

    @SubCommand('android', 'generate-sdk-bindings',
                """Generate SDK bindings used when building GeckoView.""")
    @CommandArgument('inputs', nargs='+', help='config files, '
                     'like [/path/to/ClassName-classes.txt]+')
    @CommandArgument('args', nargs=argparse.REMAINDER)
    def android_generate_sdk_bindings(self, inputs, args):
        import itertools

        def stem(input):
            # Turn "/path/to/ClassName-classes.txt" into "ClassName".
            return os.path.basename(input).rsplit('-classes.txt', 1)[0]

        bindings_inputs = list(itertools.chain(*((input, stem(input)) for input in inputs)))
        bindings_args = '-Pgenerate_sdk_bindings_args={}'.format(':'.join(bindings_inputs))

        ret = self.gradle(
            self.substs['GRADLE_ANDROID_GENERATE_SDK_BINDINGS_TASKS'] + [bindings_args] + args,
            verbose=True)

        return ret

    @SubCommand('android', 'generate-generated-jni-wrappers',
                """Generate GeckoView JNI wrappers used when building GeckoView.""")
    @CommandArgument('args', nargs=argparse.REMAINDER)
    def android_generate_generated_jni_wrappers(self, args):
        ret = self.gradle(
            self.substs['GRADLE_ANDROID_GENERATE_GENERATED_JNI_WRAPPERS_TASKS'] + args,
            verbose=True)

        return ret

    @SubCommand('android', 'generate-fennec-jni-wrappers',
                """Generate Fennec-specific JNI wrappers used when building
                Firefox for Android.""")
    @CommandArgument('args', nargs=argparse.REMAINDER)
    def android_generate_fennec_jni_wrappers(self, args):
        ret = self.gradle(
            self.substs['GRADLE_ANDROID_GENERATE_FENNEC_JNI_WRAPPERS_TASKS'] + args, verbose=True)

        return ret

    @SubCommand('android', 'api-lint',
                """Run Android api-lint.
REMOVED/DEPRECATED: Use 'mach lint --linter android-api-lint'.""")
    def android_apilint_REMOVED(self):
        print(LINT_DEPRECATION_MESSAGE)
        return 1

    @SubCommand('android', 'test',
                """Run Android test.
REMOVED/DEPRECATED: Use 'mach lint --linter android-test'.""")
    def android_test_REMOVED(self):
        print(LINT_DEPRECATION_MESSAGE)
        return 1

    @SubCommand('android', 'lint',
                """Run Android lint.
REMOVED/DEPRECATED: Use 'mach lint --linter android-lint'.""")
    def android_lint_REMOVED(self):
        print(LINT_DEPRECATION_MESSAGE)
        return 1

    @SubCommand('android', 'checkstyle',
                """Run Android checkstyle.
REMOVED/DEPRECATED: Use 'mach lint --linter android-checkstyle'.""")
    def android_checkstyle_REMOVED(self):
        print(LINT_DEPRECATION_MESSAGE)
        return 1

    @SubCommand('android', 'findbugs',
                """Run Android findbugs.
REMOVED/DEPRECATED: Use 'mach lint --linter android-findbugs'.""")
    def android_findbugs_REMOVED(self):
        print(LINT_DEPRECATION_MESSAGE)
        return 1

    @SubCommand('android', 'gradle-dependencies',
                """Collect Android Gradle dependencies.
        See http://firefox-source-docs.mozilla.org/build/buildsystem/toolchains.html#firefox-for-android-with-gradle""")  # NOQA: E501
    @CommandArgument('args', nargs=argparse.REMAINDER)
    def android_gradle_dependencies(self, args):
        # We don't want to gate producing dependency archives on clean
        # lint or checkstyle, particularly because toolchain versions
        # can change the outputs for those processes.
        self.gradle(self.substs['GRADLE_ANDROID_DEPENDENCIES_TASKS'] +
                    ["--continue"] + args, verbose=True)

        return 0

    @SubCommand('android', 'archive-geckoview',
                """Create GeckoView archives.
        See http://firefox-source-docs.mozilla.org/build/buildsystem/toolchains.html#firefox-for-android-with-gradle""")  # NOQA: E501
    @CommandArgument('args', nargs=argparse.REMAINDER)
    def android_archive_geckoview(self, args):
        ret = self.gradle(
            self.substs['GRADLE_ANDROID_ARCHIVE_GECKOVIEW_TASKS'] + args,
            verbose=True)

        return ret

    @SubCommand('android', 'build-geckoview_example',
                """Build geckoview_example """)
    @CommandArgument('args', nargs=argparse.REMAINDER)
    def android_build_geckoview_example(self, args):
        self.gradle(self.substs['GRADLE_ANDROID_BUILD_GECKOVIEW_EXAMPLE_TASKS'] + args,
                    verbose=True)

        print('Execute `mach android install-geckoview_example` '
              'to push the geckoview_example and test APKs to a device.')

        return 0

    @SubCommand('android', 'install-geckoview_example',
                """Install geckoview_example """)
    @CommandArgument('args', nargs=argparse.REMAINDER)
    def android_install_geckoview_example(self, args):
        self.gradle(self.substs['GRADLE_ANDROID_INSTALL_GECKOVIEW_EXAMPLE_TASKS'] + args,
                    verbose=True)

        print('Execute `mach android build-geckoview_example` '
              'to just build the geckoview_example and test APKs.')

        return 0

    @SubCommand('android', 'geckoview-docs',
                """Create GeckoView javadoc and optionally upload to Github""")
    @CommandArgument('--archive', action='store_true',
                     help='Generate a javadoc archive.')
    @CommandArgument('--upload', metavar='USER/REPO',
                     help='Upload generated javadoc to Github, '
                     'using the specified USER/REPO.')
    @CommandArgument('--upload-branch', metavar='BRANCH[/PATH]',
                     default='gh-pages/javadoc',
                     help='Use the specified branch/path for commits.')
    @CommandArgument('--upload-message', metavar='MSG',
                     default='GeckoView docs upload',
                     help='Use the specified message for commits.')
    def android_geckoview_docs(self, archive, upload, upload_branch,
                               upload_message):

        tasks = (self.substs['GRADLE_ANDROID_GECKOVIEW_DOCS_ARCHIVE_TASKS'] if archive or upload
                 else self.substs['GRADLE_ANDROID_GECKOVIEW_DOCS_TASKS'])

        ret = self.gradle(tasks, verbose=True)
        if ret or not upload:
            return ret

        # Upload to Github.
        fmt = {
            'level': os.environ.get('MOZ_SCM_LEVEL', '0'),
            'project': os.environ.get('MH_BRANCH', 'unknown'),
            'revision': os.environ.get('GECKO_HEAD_REV', 'tip'),
        }
        env = {}

        # In order to push to GitHub from TaskCluster, we store a private key
        # in the TaskCluster secrets store in the format {"content": "<KEY>"},
        # and the corresponding public key as a writable deploy key for the
        # destination repo on GitHub.
        secret = os.environ.get('GECKOVIEW_DOCS_UPLOAD_SECRET', '').format(**fmt)
        if secret:
            # Set up a private key from the secrets store if applicable.
            import requests
            req = requests.get('http://taskcluster/secrets/v1/secret/' + secret)
            req.raise_for_status()

            keyfile = mozpath.abspath('gv-docs-upload-key')
            with open(keyfile, 'w') as f:
                os.chmod(keyfile, 0o600)
                f.write(req.json()['secret']['content'])

            # Turn off strict host key checking so ssh does not complain about
            # unknown github.com host. We're not pushing anything sensitive, so
            # it's okay to not check GitHub's host keys.
            env['GIT_SSH_COMMAND'] = 'ssh -i "%s" -o StrictHostKeyChecking=no' % keyfile

        # Clone remote repo.
        branch, _, branch_path = upload_branch.partition('/')
        repo_url = 'git@github.com:%s.git' % upload
        repo_path = mozpath.abspath('gv-docs-repo')
        self.run_process(['git', 'clone', '--branch', branch, '--depth', '1',
                          repo_url, repo_path], append_env=env, pass_thru=True)
        env['GIT_DIR'] = mozpath.join(repo_path, '.git')
        env['GIT_WORK_TREE'] = repo_path
        env['GIT_AUTHOR_NAME'] = env['GIT_COMMITTER_NAME'] = 'GeckoView Docs Bot'
        env['GIT_AUTHOR_EMAIL'] = env['GIT_COMMITTER_EMAIL'] = 'nobody@mozilla.com'

        # Extract new javadoc to specified directory inside repo.
        import mozfile
        src_tar = mozpath.join(self.topobjdir, 'gradle', 'build', 'mobile', 'android',
                               'geckoview', 'libs', 'geckoview-javadoc.jar')
        dst_path = mozpath.join(repo_path, branch_path.format(**fmt))
        mozfile.remove(dst_path)
        mozfile.extract_zip(src_tar, dst_path)

        # Commit and push.
        self.run_process(['git', 'add', '--all'], append_env=env, pass_thru=True)
        if self.run_process(['git', 'diff', '--cached', '--quiet'],
                            append_env=env, pass_thru=True, ensure_exit_code=False) != 0:
            # We have something to commit.
            self.run_process(['git', 'commit',
                              '--message', upload_message.format(**fmt)],
                             append_env=env, pass_thru=True)
            self.run_process(['git', 'push', 'origin', 'gh-pages'],
                             append_env=env, pass_thru=True)

        mozfile.remove(repo_path)
        if secret:
            mozfile.remove(keyfile)
        return 0

    @Command('gradle', category='devenv',
             description='Run gradle.',
             conditions=[conditions.is_android])
    @CommandArgument('-v', '--verbose', action='store_true',
                     help='Verbose output for what commands the build is running.')
    @CommandArgument('args', nargs=argparse.REMAINDER)
    def gradle(self, args, verbose=False):
        if not verbose:
            # Avoid logging the command
            self.log_manager.terminal_handler.setLevel(logging.CRITICAL)

        # In automation, JAVA_HOME is set via mozconfig, which needs
        # to be specially handled in each mach command. This turns
        # $JAVA_HOME/bin/java into $JAVA_HOME.
        java_home = os.path.dirname(os.path.dirname(self.substs['JAVA']))

        gradle_flags = self.substs.get('GRADLE_FLAGS', '') or \
            os.environ.get('GRADLE_FLAGS', '')
        gradle_flags = shell_split(gradle_flags)

        # We force the Gradle JVM to run with the UTF-8 encoding, since we
        # filter strings.xml, which is really UTF-8; the ellipsis character is
        # replaced with ??? in some encodings (including ASCII).  It's not yet
        # possible to filter with encodings in Gradle
        # (https://github.com/gradle/gradle/pull/520) and it's challenging to
        # do our filtering with Gradle's Ant support.  Moreover, all of the
        # Android tools expect UTF-8: see
        # http://tools.android.com/knownissues/encoding.  See
        # http://stackoverflow.com/a/21267635 for discussion of this approach.
        #
        # It's not even enough to set the encoding just for Gradle; it
        # needs to be for JVMs spawned by Gradle as well.  This
        # happens during the maven deployment generating the GeckoView
        # documents; this works around "error: unmappable character
        # for encoding ASCII" in exoplayer2.  See
        # https://discuss.gradle.org/t/unmappable-character-for-encoding-ascii-when-building-a-utf-8-project/10692/11  # NOQA: E501
        # and especially https://stackoverflow.com/a/21755671.

        if self.substs.get('MOZ_AUTOMATION'):
            gradle_flags += ['--console=plain']

        env = os.environ.copy()
        env.update({
            'GRADLE_OPTS': '-Dfile.encoding=utf-8',
            'JAVA_HOME': java_home,
            'JAVA_TOOL_OPTIONS': '-Dfile.encoding=utf-8',
        })
        # Set ANDROID_SDK_ROOT if --with-android-sdk was set.
        # See https://bugzilla.mozilla.org/show_bug.cgi?id=1576471
        android_sdk_root = self.substs.get('ANDROID_SDK_ROOT', '')
        if android_sdk_root:
            env['ANDROID_SDK_ROOT'] = android_sdk_root

        return self.run_process(
            [self.substs['GRADLE']] + gradle_flags + args,
            explicit_env=env,
            pass_thru=True,  # Allow user to run gradle interactively.
            ensure_exit_code=False,  # Don't throw on non-zero exit code.
            cwd=mozpath.join(self.topsrcdir))

    @Command('gradle-install', category='devenv',
             conditions=[REMOVED])
    def gradle_install_REMOVED(self):
        pass

    @Command('install-android', category='post-build',
             conditional_name='install',
             conditions=[conditions.is_android],
             description='Install an Android package on a device or an emulator.')
    @CommandArgument('--verbose', '-v', action='store_true',
                     help='Print verbose output when installing.')
    def install(self, verbose=False):
        from mozrunner.devices.android_device import verify_android_device
        verify_android_device(self, verbose=verbose)

        ret = self._run_make(directory='.', target='install', ensure_exit_code=False)
        if ret == 0:
            self.notify('Install complete')
        return ret

    @Command('run-android', category='post-build',
             conditional_name='run',
             conditions=[conditions.is_android],
             description='Run an application on an Android device or an emulator.')
    @CommandArgument('--app', help='Android package to run '
                     '(default: org.mozilla.geckoview_example)',
                     default='org.mozilla.geckoview_example')
    @CommandArgument('--intent', help='Android intent action to launch with '
                     '(default: android.intent.action.VIEW)',
                     default='android.intent.action.VIEW')
    @CommandArgument('--setenv', dest='env', action='append',
                     help='Set target environment variable, like FOO=BAR',
                     default=[])
    @CommandArgument('--profile', '-P', help='Path to Gecko profile, like /path/to/host/profile '
                     'or /path/to/target/profile',
                     default=None)
    @CommandArgument('--url', help='URL to open',
                     default=None)
    @CommandArgument('--no-install', help='Do not try to install application on device before ' +
                     'running (default: False)',
                     action='store_true',
                     default=False)
    @CommandArgument('--no-wait', help='Do not wait for application to start before returning ' +
                     '(default: False)',
                     action='store_true',
                     default=False)
    @CommandArgument('--fail-if-running', help='Fail if application is already running ' +
                     '(default: False)',
                     action='store_true',
                     default=False)
    @CommandArgument('--restart', help='Stop the application if it is already running ' +
                     '(default: False)',
                     action='store_true',
                     default=False)
    def run(self, app='org.mozilla.geckoview_example', intent=None,
            env=[], profile=None,
            url=None, no_install=None, no_wait=None, fail_if_running=None, restart=None):
        from mozrunner.devices.android_device import verify_android_device, _get_device
        from six.moves import shlex_quote

        if app == 'org.mozilla.geckoview_example':
            activity_name = 'org.mozilla.geckoview_example.GeckoViewActivity'
        elif app == 'org.mozilla.geckoview.test':
            activity_name = 'org.mozilla.geckoview.test.TestRunnerActivity'
        elif 'fennec' in app or 'firefox' in app:
            activity_name = 'org.mozilla.gecko.BrowserApp'
        else:
            raise RuntimeError('Application not recognized: {}'.format(app))

        # `verify_android_device` respects `DEVICE_SERIAL` if it is set and sets it otherwise.
        verify_android_device(self, app=app, install=not no_install)
        device_serial = os.environ.get('DEVICE_SERIAL')
        if not device_serial:
            print('No ADB devices connected.')
            return 1

        device = _get_device(self.substs, device_serial=device_serial)

        args = []
        if profile:
            if os.path.isdir(profile):
                host_profile = profile
                # Always /data/local/tmp, rather than `device.test_root`, because GeckoView only
                # takes its configuration file from /data/local/tmp, and we want to follow suit.
                target_profile = '/data/local/tmp/{}-profile'.format(app)
                device.rm(target_profile, recursive=True, force=True)
                device.push(host_profile, target_profile)
                self.log(logging.INFO, "run",
                         {'host_profile': host_profile, 'target_profile': target_profile},
                         'Pushed profile from host "{host_profile}" to target "{target_profile}"')
            else:
                target_profile = profile
                self.log(logging.INFO, "run",
                         {'target_profile': target_profile},
                         'Using profile from target "{target_profile}"')

            args = ['--profile', shlex_quote(target_profile)]

        extras = {}
        for i, e in enumerate(env):
            extras['env{}'.format(i)] = e
        if args:
            extras['args'] = " ".join(args)
        extras['use_multiprocess'] = True  # Only GVE and TRA process this extra.

        if env or args:
            restart = True

        if restart:
            fail_if_running = False
            self.log(logging.INFO, "run",
                     {'app': app},
                     'Stopping {app} to ensure clean restart.')
            device.stop_application(app)

        # We'd prefer to log the actual `am start ...` command, but it's not trivial to wire the
        # device's logger to mach's logger.
        self.log(logging.INFO, "run",
                 {'app': app, 'activity_name': activity_name},
                 'Starting {app}/{activity_name}.')

        device.launch_application(
            app_name=app,
            activity_name=activity_name,
            intent=intent,
            extras=extras,
            url=url,
            wait=not no_wait,
            fail_if_running=fail_if_running)

        return 0


@CommandProvider
class AndroidEmulatorCommands(MachCommandBase):
    """
       Run the Android emulator with one of the AVDs used in the Mozilla
       automated test environment. If necessary, the AVD is fetched from
       the tooltool server and installed.
    """
    @Command('android-emulator', category='devenv',
             conditions=[],
             description='Run the Android emulator with an AVD from test automation.')
    @CommandArgument('--version', metavar='VERSION',
                     choices=['4.3', 'x86', 'x86-7.0'],
                     help='Specify Android version to run in emulator. '
                     'One of "4.3", "x86", or "x86-7.0".')
    @CommandArgument('--wait', action='store_true',
                     help='Wait for emulator to be closed.')
    @CommandArgument('--force-update', action='store_true',
                     help='Update AVD definition even when AVD is already installed.')
    @CommandArgument('--verbose', action='store_true',
                     help='Log informative status messages.')
    def emulator(self, version, wait=False, force_update=False, verbose=False):
        from mozrunner.devices.android_device import AndroidEmulator

        emulator = AndroidEmulator(version, verbose, substs=self.substs,
                                   device_serial='emulator-5554')
        if emulator.is_running():
            # It is possible to run multiple emulators simultaneously, but:
            #  - if more than one emulator is using the same avd, errors may
            #    occur due to locked resources;
            #  - additional parameters must be specified when running tests,
            #    to select a specific device.
            # To avoid these complications, allow just one emulator at a time.
            self.log(logging.ERROR, "emulator", {},
                     "An Android emulator is already running.\n"
                     "Close the existing emulator and re-run this command.")
            return 1

        if not emulator.is_available():
            self.log(logging.WARN, "emulator", {},
                     "Emulator binary not found.\n"
                     "Install the Android SDK and make sure 'emulator' is in your PATH.")
            return 2

        if not emulator.check_avd(force_update):
            self.log(logging.INFO, "emulator", {},
                     "Fetching and installing AVD. This may take a few minutes...")
            emulator.update_avd(force_update)

        self.log(logging.INFO, "emulator", {},
                 "Starting Android emulator running %s..." %
                 emulator.get_avd_description())
        emulator.start()
        if emulator.wait_for_start():
            self.log(logging.INFO, "emulator", {},
                     "Android emulator is running.")
        else:
            # This is unusual but the emulator may still function.
            self.log(logging.WARN, "emulator", {},
                     "Unable to verify that emulator is running.")

        if conditions.is_android(self):
            self.log(logging.INFO, "emulator", {},
                     "Use 'mach install' to install or update Firefox on your emulator.")
        else:
            self.log(logging.WARN, "emulator", {},
                     "No Firefox for Android build detected.\n"
                     "Switch to a Firefox for Android build context or use 'mach bootstrap'\n"
                     "to setup an Android build environment.")

        if wait:
            self.log(logging.INFO, "emulator", {},
                     "Waiting for Android emulator to close...")
            rc = emulator.wait()
            if rc is not None:
                self.log(logging.INFO, "emulator", {},
                         "Android emulator completed with return code %d." % rc)
            else:
                self.log(logging.WARN, "emulator", {},
                         "Unable to retrieve Android emulator return code.")
        return 0
