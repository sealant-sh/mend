/**
 * The name and words each of Mend's spans reads by in Sentry (SLNT-1407). The code names a span
 * for the function it times (`Effect.fn("SessionEngine.provision")`); a person reading a trace
 * wants the operation (`mend.session.provision`, "record new session"). The exporter renames each
 * span by this table (`enrich.ts`) and keeps the code's name in `code.function.name`.
 *
 * - A name is `mend.<area>.<operation>`, lower snake case: `area` one of `AREAS`, Mend's own nouns,
 *   and `operation` what happens, a verb or a verb and its object. Never a function's shape
 *   (`_as`, `_for`, `_of`, `_once`, `_if_needed`) or a class's name.
 * - A description is two to five lower-case words that say what happened, and no other name has it.
 * - Two spans share a name only when they do the same thing (each agent adapter's `send_turn`).
 *
 * Every span the source names is here: `span-names.test.ts` and the `mend/span-name` lint rule
 * hold the source and this table to each other and to the convention. Dependency-free: the lint
 * rule loads it.
 */

/** The areas of `mend.<area>.<operation>`: the product's nouns, never a class's. */
export const AREAS: ReadonlySet<string> = new Set([
  "access",
  "agent",
  "auth",
  "blob",
  "capture",
  "change",
  "checkpoint",
  "db",
  "dotfiles",
  "folder",
  "gateway",
  "github",
  "handoff",
  "harness",
  "home",
  "inference",
  "job",
  "landing",
  "mcp",
  "member",
  "memory",
  "mode",
  "notification",
  "page",
  "preview",
  "process",
  "project",
  "pull_request",
  "resource",
  "review",
  "run",
  "screen",
  "sealant",
  "service",
  "session",
  "shell",
  "signer",
  "slack",
  "store",
  "turn",
  "web",
  "workspace",
  "worktree",
]);

/** By the name the code gives a span: the name and description Sentry shows. */
export const SPAN_NAMES: Readonly<Record<string, readonly [name: string, description: string]>> = {
  // auth
  "Auth.accessKeySession": ["mend.auth.authenticate_access_key", "authenticate access key"],
  "Auth.getSession": ["mend.auth.authenticate_request", "authenticate request"],
  // access
  "ProjectAccess.change": ["mend.access.authorize_change", "authorize change"],
  "ProjectAccess.requireOperator": ["mend.access.authorize_operator", "authorize operator"],
  "ProjectAccess.requireOwner": ["mend.access.authorize_owner", "authorize organization owner"],
  "ProjectAccess.sessionAsMember": [
    "mend.access.authorize_page_viewer",
    "authorize session page viewer",
  ],
  "ProjectAccess.projectAs": ["mend.access.authorize_project", "authorize project"],
  "ProjectAccess.manageProject": [
    "mend.access.authorize_project_management",
    "authorize project management",
  ],
  "ProjectAccess.sessionAs": ["mend.access.authorize_session", "authorize session"],
  "ProjectAccess.sessionView": ["mend.access.authorize_session_view", "authorize session view"],
  "ProjectAccess.worktree": ["mend.access.authorize_worktree", "authorize worktree"],
  "ProjectAccess.visibleProjectsOf": ["mend.access.list_visible_projects", "list visible projects"],
  "SessionEngine.reconcileAccess": [
    "mend.access.stop_revoked_sessions",
    "stop sessions that lost access",
  ],
  // session
  "SessionEngine.attachRun": ["mend.session.attach_run", "attach sealant run to session"],
  "SessionEngine.classifyUnclassifiedSessions": [
    "mend.session.classify_transcripts",
    "classify restart transcripts",
  ],
  "SessionStart.createAs": ["mend.session.create", "create session"],
  "SessionStart.createInWorktreeAs": ["mend.session.join_worktree", "create session in worktree"],
  "mend.session.launch": ["mend.session.launch", "launch session"],
  "SessionEngine.launchProtocol": ["mend.session.launch_conversation", "launch conversation agent"],
  "SessionEngine.launchFollowUp": [
    "mend.session.launch_follow_up",
    "launch session with follow-up",
  ],
  "SessionEngine.launchInRetainedWorkspace": [
    "mend.session.launch_retained",
    "launch in retained workspace",
  ],
  "SessionNamer.name": ["mend.session.name", "name session from prompt"],
  "SessionEngine.provision": ["mend.session.provision", "record new session"],
  "SessionEngine.reconcileSession": ["mend.session.reconcile", "reconcile session status"],
  "SessionEngine.rehydrateProtocolProcess": [
    "mend.session.recover_conversation",
    "recover conversation after restart",
  ],
  "SessionEngine.relaunchProtocolProcess": [
    "mend.session.relaunch_conversation",
    "relaunch unrecoverable conversation agent",
  ],
  "SessionEngine.removeWhenStopped": ["mend.session.remove", "remove stopped session"],
  "SessionEngine.startInConversation": [
    "mend.session.restart_shared_conversation",
    "restart shared conversation as sender",
  ],
  "SessionEngine.resumeSession": ["mend.session.resume", "resume session"],
  "SessionEngine.resume": ["mend.session.resume_all", "resume sessions at boot"],
  "mend.session.start": ["mend.session.start", "create and launch session"],
  "QueuedSessions.startClaimed": ["mend.session.start_queued", "start queued session"],
  "SessionEngine.stop": ["mend.session.stop", "stop session"],
  "SessionEngine.stopSession": ["mend.session.stop_and_release", "stop session and workspace"],
  "ProtocolIdleStop.stopIfIdle": ["mend.session.stop_idle_conversation", "stop idle conversation"],
  "TerminalIdleStop.stopIfIdle": ["mend.session.stop_idle_terminal", "stop idle terminal"],
  "SessionEngine.supervise": ["mend.session.supervise", "supervise session run"],
  "ProtocolIdleStop.sweep": [
    "mend.session.sweep_idle_conversations",
    "sweep idle conversation sessions",
  ],
  "TerminalIdleStop.sweep": ["mend.session.sweep_idle_terminals", "sweep idle terminal sessions"],
  // mode
  "SessionEngine.switchModeEnding": ["mend.mode.hand_over_agent", "hand agent to new mode"],
  "SessionEngine.switchMode": ["mend.mode.switch", "switch session mode"],
  "SessionEngine.switchConversationToTerminal": [
    "mend.mode.switch_to_terminal",
    "switch conversation to terminal",
  ],
  // turn
  "SessionEngine.steerTurn": ["mend.turn.accept_steer", "check and send steer"],
  "SessionEngine.submitTurnChecked": ["mend.turn.accept_message", "check sender and submit turn"],
  "mend.turn.complete": ["mend.turn.complete", "complete turn"],
  "ProtocolHost.deliverSteer": ["mend.turn.deliver_steer", "deliver steer to turn"],
  "mend.turn.dispatch": ["mend.turn.dispatch", "dispatch turn"],
  "mend.turn.first_output": ["mend.turn.first_output", "receive first agent output"],
  "mend.turn.input": ["mend.turn.input", "send turn input"],
  "ProtocolHost.interruptTurn": ["mend.turn.interrupt", "interrupt turn"],
  "SessionEngine.sendTerminalMessage": [
    "mend.turn.queue_terminal_message",
    "queue message for terminal agent",
  ],
  "SessionEngine.respondRequest": ["mend.turn.respond", "answer agent request"],
  "mend.turn.run": ["mend.turn.run", "run turn"],
  "ProtocolHost.sendMessage": ["mend.turn.send_message", "send conversation message"],
  "ProtocolHost.sendSteer": ["mend.turn.send_steer", "send steer and await turn"],
  "ProtocolHost.steerTurn": ["mend.turn.steer", "steer running turn"],
  "ProtocolHost.submitTurn": ["mend.turn.submit", "submit turn"],
  "SessionEngine.deliverTerminalTurns": [
    "mend.turn.type_into_terminal",
    "type queued message into terminal",
  ],
  // agent
  "AntigravityAdapter.respond": ["mend.agent.answer_approval", "answer agent approval request"],
  "ClaudeAdapter.respond": ["mend.agent.answer_approval", "answer agent approval request"],
  "CodexAdapter.respond": ["mend.agent.answer_approval", "answer agent approval request"],
  "AntigravityAdapter.respondInput": ["mend.agent.answer_question", "answer agent input request"],
  "ClaudeAdapter.respondInput": ["mend.agent.answer_question", "answer agent input request"],
  "CodexAdapter.respondInput": ["mend.agent.answer_question", "answer agent input request"],
  "ClaudeAdapter.selectionControl": ["mend.agent.apply_selection", "apply turn selection to agent"],
  "ProtocolHost.attach": ["mend.agent.attach", "attach agent adapter"],
  "AntigravityAdapter.call": ["mend.agent.call", "call agent protocol method"],
  "CodexAdapter.call": ["mend.agent.call", "call agent protocol method"],
  "CodexAdapter.quiescence": ["mend.agent.check_quiescence", "check agent background work"],
  "AntigravityAdapter.close": ["mend.agent.close", "close agent protocol connection"],
  "ClaudeAdapter.close": ["mend.agent.close", "close agent protocol connection"],
  "CodexAdapter.close": ["mend.agent.close", "close agent protocol connection"],
  "SessionEngine.commitConversationState": [
    "mend.agent.commit_opencode_state",
    "commit opencode conversation state",
  ],
  "ClaudeAdapter.endWork": ["mend.agent.end_background_work", "end agent background work"],
  "CodexAdapter.endWork": ["mend.agent.end_background_work", "end agent background work"],
  "AntigravityAdapter.interrupt": ["mend.agent.interrupt_turn", "ask agent to interrupt"],
  "ClaudeAdapter.interrupt": ["mend.agent.interrupt_turn", "ask agent to interrupt"],
  "CodexAdapter.interrupt": ["mend.agent.interrupt_turn", "ask agent to interrupt"],
  "SessionEngine.observeExternalAgents": [
    "mend.agent.observe_external",
    "observe external agent processes",
  ],
  "ProtocolHost.rehydrate": ["mend.agent.rehydrate", "rehydrate agent adapter from replay"],
  "SessionEngine.deliverNativeBootstrap": [
    "mend.agent.seed_native_history",
    "seed native conversation history",
  ],
  "ProtocolHost.respondRequest": ["mend.agent.send_response", "send request answer to agent"],
  "AntigravityAdapter.sendTurn": ["mend.agent.send_turn", "deliver turn prompt to agent"],
  "ClaudeAdapter.sendTurn": ["mend.agent.send_turn", "deliver turn prompt to agent"],
  "CodexAdapter.sendTurn": ["mend.agent.send_turn", "deliver turn prompt to agent"],
  "SessionEngine.opencodeLaunchSnapshot": [
    "mend.agent.snapshot_opencode_conversations",
    "read opencode conversations before launch",
  ],
  "ClaudeAdapter.steer": ["mend.agent.steer_turn", "send steer to agent"],
  "CodexAdapter.steer": ["mend.agent.steer_turn", "send steer to agent"],
  // harness
  "SessionEngine.relocateHarnessHome": [
    "mend.harness.relocate_home",
    "relocate harness home directories",
  ],
  // process
  "SessionEngine.endAgentProcess": ["mend.process.record_agent_end", "record agent process end"],
  // workspace
  "SessionEngine.adoptClaimedWorkspace": [
    "mend.workspace.adopt_standby",
    "adopt claimed standby workspace",
  ],
  "SessionEngine.executorLostOnEnd": ["mend.workspace.check_lost", "check workspace loss at end"],
  "SessionEngine.runDrain": ["mend.workspace.drain", "drain and save workspace"],
  "SessionEngine.changingBoatKey.drain": [
    "mend.workspace.drain_boat_standbys",
    "drain standbys for key change",
  ],
  "SessionEngine.installDependenciesIfNeeded": [
    "mend.workspace.install_dependencies",
    "install workspace dependencies",
  ],
  "SessionEngine.prepareExecutor": ["mend.workspace.prepare", "prepare new workspace"],
  "SessionEngine.provisionWorkspace": ["mend.workspace.provision", "provision workspace"],
  "SessionEngine.provisionHotWorkspace": [
    "mend.workspace.provision_standby",
    "provision standby workspace",
  ],
  "SessionEngine.readWorkspaceMendToml": [
    "mend.workspace.read_mend_toml",
    "read mend.toml in workspace",
  ],
  "SessionEngine.captureReaper": ["mend.workspace.reap_leases", "reap leases and stalled drains"],
  "SessionEngine.sweepLeftovers": [
    "mend.workspace.reap_leftovers",
    "reap leftover settled workspaces",
  ],
  "SessionEngine.rebindExecutorScopes": [
    "mend.workspace.rebind_sockets",
    "rebind workspace socket scopes",
  ],
  "SessionEngine.reconcileHotPoolOnce": [
    "mend.workspace.reconcile_standby_pool",
    "reconcile project standby pool",
  ],
  "SessionEngine.recordKept": ["mend.workspace.record_kept", "record workspace kept unsaved"],
  "SessionEngine.recoverRetiring": [
    "mend.workspace.recover_retirement",
    "recover stalled workspace retirement",
  ],
  "SessionEngine.retainedWorkspaceSweep": [
    "mend.workspace.renew_ttl",
    "renew leased workspace ttls",
  ],
  "SessionEngine.replaceExecutor": [
    "mend.workspace.replace_capped",
    "replace or resume capped workspace",
  ],
  "SessionEngine.replaceWorkspaceNow": [
    "mend.workspace.replace_on_request",
    "replace workspace for owner",
  ],
  "SessionEngine.replaceRetiring": [
    "mend.workspace.replace_retiring",
    "replace retiring workspace",
  ],
  "HarnessLayoutSteps.resetSshUser": ["mend.workspace.reset_ssh_user", "reset workspace ssh user"],
  "SessionEngine.sweepRetirements": [
    "mend.workspace.sweep_retirements",
    "check workspaces marked to retire",
  ],
  "SessionEngine.hotPoolSweep": [
    "mend.workspace.sweep_standby_pool",
    "sweep standby workspace pool",
  ],
  "SessionEngine.terminateWorkspace": ["mend.workspace.terminate", "terminate workspace"],
  "SessionEngine.wakeWorkspace": ["mend.workspace.wake", "wake workspace"],
  "SessionEngine.writeWorkspaceFiles": ["mend.workspace.write_files", "write files into workspace"],
  "SessionEngine.applyGitAuthor": ["mend.workspace.write_git_author", "write git author config"],
  "SessionEngine.appendWorkspaceNote": ["mend.workspace.write_note", "write workspace note"],
  // home
  "DotfilesCloner.archive": ["mend.home.archive_dotfiles", "clone and pack dotfiles"],
  "SessionEngine.deliverToPerson": ["mend.home.deliver", "deliver person home files"],
  "SessionEngine.deliverSecretFiles": ["mend.home.deliver_secret_files", "deliver secret files"],
  "SessionEngine.deliverSkillsToWorkspace": [
    "mend.home.deliver_skills",
    "deliver skills into home",
  ],
  "HarnessLayoutSteps.processAs": ["mend.home.prepare", "prepare person home for process"],
  "HarnessLayoutSteps.reconcileLogins": [
    "mend.home.reconcile_logins",
    "reconcile executor home logins",
  ],
  "HarnessLayoutSteps.releaseIdle": ["mend.home.release_idle_logins", "release idle person logins"],
  "HarnessLayoutSteps.relogin": ["mend.home.rewrite_logins", "rewrite logins after auth failure"],
  "SessionEngine.evictReservedSecretFiles": [
    "mend.home.set_aside_secret_files",
    "set aside reserved secret files",
  ],
  "HarnessLayoutSteps.writeLogins": ["mend.home.write_logins", "write person logins"],
  "SessionEngine.applyDefaultShellProfile": [
    "mend.home.write_shell_profile",
    "write default shell profile",
  ],
  // memory
  "SessionEngine.deliverAgentMemory": ["mend.memory.deliver", "deliver owner agent memory"],
  "SessionEngine.deliverPersonMemory": [
    "mend.memory.deliver_person",
    "deliver person agent memory",
  ],
  "SessionEngine.migratePreReleaseMemory": [
    "mend.memory.migrate_pre_release",
    "migrate pre-release agent memory",
  ],
  "SessionEngine.readBackAgentMemory": ["mend.memory.read_back", "read back agent memory"],
  // worktree
  "SessionEngine.createWorktreeIn": ["mend.worktree.create", "create worktree"],
  "Store.removeWorktree": ["mend.worktree.remove", "remove store worktree"],
  "Store.resetWorktree": ["mend.worktree.reset", "reset worktree to base"],
  "SessionEngine.takeWorktreeSnapshot": ["mend.worktree.snapshot", "snapshot worktree"],
  "ProjectLocalWorktrees.start": ["mend.worktree.start_local", "start project local worktree"],
  // checkpoint
  "SessionEngine.checkpointNow": ["mend.checkpoint.save", "save checkpoint on demand"],
  "SessionEngine.landingCheckpoint": ["mend.checkpoint.save_landing", "save landing checkpoint"],
  "SessionEngine.takeCheckpoint": ["mend.checkpoint.take", "take session checkpoint"],
  "Store.checkpoint": ["mend.checkpoint.write_commit", "write checkpoint commit"],
  // capture
  "CaptureRetention.run": ["mend.capture.apply_retention", "thin and retire captures"],
  "SessionCaptureApi.uploadComplete": [
    "mend.capture.complete_upload",
    "complete capture multipart upload",
  ],
  "SessionEngine.flushCaptures": ["mend.capture.flush", "flush worktree captures"],
  "CaptureSources.publish": ["mend.capture.publish_source", "publish capture source archive"],
  "SessionEngine.observeCaptureFlush": [
    "mend.capture.request_flush",
    "request workspace capture flush",
  ],
  "SessionCaptureApi.uploadUrls": ["mend.capture.sign_upload_urls", "sign capture upload urls"],
  // blob
  "BlobStore.remove": ["mend.blob.delete", "delete stored blob"],
  "BlobStore.createMultipart": ["mend.blob.start_upload", "start multipart blob upload"],
  // change
  "GitOpsRunner.bundle": ["mend.change.bundle", "bundle change for pull"],
  "Landing.bundle": ["mend.change.bundle", "bundle change for pull"],
  "Store.bundle": ["mend.change.bundle", "bundle change for pull"],
  "Store.diffWorktree": ["mend.change.diff_worktree", "diff worktree against base"],
  // review
  "ReviewPrep.observe": ["mend.review.check_settled", "check session settled for review"],
  "BriefCompiler.compile": ["mend.review.compile_brief", "compile change brief"],
  "TourComposer.compose": ["mend.review.compose_tour", "compose review tour"],
  "FollowUpDelivery.deliver": ["mend.review.deliver_follow_up", "deliver review follow-up"],
  "SummaryObserver.observe": ["mend.review.observe_summary", "recompute change summary"],
  "SessionChanges.openReviewResult": ["mend.review.open_slice", "open review slice"],
  "ReviewPrep.prepare": ["mend.review.prepare", "prepare change review"],
  "ReviewPrep.queuePasses": ["mend.review.queue_passes", "queue review passes"],
  "ChangeReader.read": ["mend.review.read_change", "draft review comments on change"],
  "ReadChange.read": ["mend.review.read_change_diff", "read diff for brief"],
  "ReadRecording.read": ["mend.review.read_recording", "read run recording for brief"],
  "ReplyOnBrief.reply": ["mend.review.reply_on_brief", "reply on brief thread"],
  "CommentRouter.route": ["mend.review.route_comment", "route reviewer comment"],
  "ChangeSuggester.suggest": ["mend.review.suggest_changes", "draft suggested changes"],
  "FailureSummarizer.summarize": ["mend.review.summarize_failure", "summarize failed run"],
  // landing
  "Landing.adoptPullRequest": ["mend.landing.adopt_pull_request", "adopt existing pull request"],
  "RequestIntentReader.read": ["mend.landing.classify_request", "classify request intent"],
  "GitOpsRunner.probeRemote": [
    "mend.landing.compare_remote_branch",
    "compare remote branch with change",
  ],
  "Store.probeRemote": ["mend.landing.compare_remote_branch", "compare remote branch with change"],
  "AutomaticLanding.consider": ["mend.landing.decide_turns", "decide automatic turn landings"],
  "OwnerLanding.land": ["mend.landing.land_by_owner", "land change as owner"],
  "Landing.land": ["mend.landing.land_change", "land change"],
  "WorkspaceLanding.land": ["mend.landing.land_from_workspace", "land change from workspace"],
  observeLandings: ["mend.landing.observe_state", "observe change landing state"],
  "GitOpsRunner.push": ["mend.landing.push_branch", "push landing branch"],
  "Store.push": ["mend.landing.push_branch", "push landing branch"],
  "Landing.refreshPullRequest": [
    "mend.landing.refresh_pull_request",
    "refresh landed pull request",
  ],
  "AutomaticLanding.sweep": ["mend.landing.sweep_ended_turns", "sweep sessions for auto-landing"],
  "GitOpsRunner.landingCommit": ["mend.landing.write_commit", "write landing commit"],
  "Store.landingCommit": ["mend.landing.write_commit", "write landing commit"],
  // pull_request
  "LandingDescriptions.afterTour": [
    "mend.pull_request.describe_tour",
    "write tour into description",
  ],
  "PullRequests.find": ["mend.pull_request.find", "find change's pull request"],
  "PullRequests.proofItems": [
    "mend.pull_request.list_proof_media",
    "list pull request proof media",
  ],
  "PullRequests.observe": ["mend.pull_request.observe", "read pull request state"],
  "PullRequests.publish": ["mend.pull_request.publish", "open or update pull request"],
  // preview
  "PreviewPreparation.consider": [
    "mend.preview.decide_preparations",
    "decide turn preview preparation",
  ],
  "PreviewIdentity.exchangeTicket": [
    "mend.preview.exchange_ticket",
    "exchange preview sign-in ticket",
  ],
  "SessionEngine.recordStop": ["mend.preview.record_stop", "record who stopped preview"],
  "SessionEngine.runPreviewStart": ["mend.preview.start", "start preview service"],
  "ProjectPreviews.start": ["mend.preview.start_project_preview", "start project preview"],
  // service
  "ServiceHost.start": ["mend.service.bind_host_port", "bind service host port"],
  "ServiceHost.startUdp": ["mend.service.bind_udp_port", "bind service udp port"],
  "ServiceHost.stop": ["mend.service.close_host_port", "close service host port"],
  "SessionEngine.runPlanSetup": ["mend.service.prepare_setup", "prepare service setup run"],
  "SessionEngine.runPlan": ["mend.service.run_plan", "run service start plan"],
  "SessionEngine.runServiceRecipe": ["mend.service.run_recipe", "run service recipe"],
  "SetupRunner.run": ["mend.service.run_setup", "run service setup steps"],
  "SessionEngine.openServiceAttempt": ["mend.service.start_attempt", "start service attempt"],
  "SessionEngine.stopService": ["mend.service.stop", "stop service"],
  "SessionEngine.stopServices": ["mend.service.stop_session_services", "stop all session services"],
  // shell
  "SessionEngine.openShell": ["mend.shell.open", "open shell"],
  "SessionEngine.stopShell": ["mend.shell.stop", "stop shell"],
  // resource
  "Resources.add": ["mend.resource.add", "add resource definition"],
  "ResourceTableWrites.appendResourceTable": [
    "mend.resource.append_table",
    "append resource table to mend.toml",
  ],
  "Resources.applyChoice": ["mend.resource.apply_choice", "apply worktree resource choice"],
  "ResourceRuntime.archive": ["mend.resource.archive_instance", "archive resource instance"],
  "ResourceRuntime.stoppedDependency": [
    "mend.resource.find_stopped_dependency",
    "find stopped service dependency",
  ],
  "Resources.list": ["mend.resource.list", "list project resources"],
  "ResourceStatusReads.forWorktree": [
    "mend.resource.read_worktree_status",
    "read worktree resource status",
  ],
  "ResourceRuntime.relink": ["mend.resource.relink_workspaces", "relink resources into workspaces"],
  "Resources.remove": ["mend.resource.remove", "remove resource definition"],
  "Resources.reset": ["mend.resource.reset", "reset resource on request"],
  "ResourceRuntime.reset": ["mend.resource.reset_database", "reset postgres database from dump"],
  "ResourceImageResolver.resolve": ["mend.resource.resolve_image", "pin resource image digest"],
  "Resources.start": ["mend.resource.start", "start resource instance"],
  "Resources.stop": ["mend.resource.stop", "stop resource instance"],
  "Resources.use": ["mend.resource.use", "set worktree resource use"],
  // screen
  "ScreenRtc.connect": ["mend.screen.connect_viewer", "connect screen webrtc viewer"],
  "ScreenRecorder.start": ["mend.screen.start_recording", "start screen recording"],
  "ScreenRecorder.stop": ["mend.screen.stop_recording", "stop screen recording"],
  "SessionEngine.wakeScreen": ["mend.screen.wake", "wake session screen"],
  // page
  "SessionPages.publish": ["mend.page.publish", "publish session page"],
  // store
  "Store.createLocalWorktree": ["mend.store.add_local_worktree", "add local-mode worktree"],
  "Store.createWorktree": ["mend.store.add_worktree", "add git worktree"],
  "Store.adopt": ["mend.store.adopt_repository", "clone repository into store"],
  "GitOpsRunner.blame": ["mend.store.blame_file", "blame file at ref"],
  "Store.cloneReference": ["mend.store.clone_reference", "clone reference repository"],
  "Store.createRepository": ["mend.store.create_repository", "create new project repository"],
  "Store.freshenBase": ["mend.store.fetch_base", "fetch base from origin"],
  "Store.refreshFromOrigin": ["mend.store.fetch_origin", "fetch all origin branches"],
  "Store.refreshReference": ["mend.store.refresh_reference", "refresh reference repository"],
  "Store.removeProjectStore": ["mend.store.remove_project", "remove project store"],
  "Store.removeReference": ["mend.store.remove_reference", "remove reference repository"],
  "Store.resolveBase": ["mend.store.resolve_base", "resolve session base commit"],
  "Store.grep": ["mend.store.search_files", "search files with grep"],
  "mend.project.sweep_unsettled_repositories": [
    "mend.store.settle_repositories",
    "settle unclaimed store repositories",
  ],
  // dotfiles
  "DotfilesStore.snapshot": ["mend.dotfiles.save_snapshot", "save synced dotfiles snapshot"],
  // folder
  "FolderStore.create": ["mend.folder.create", "create organization folder"],
  "FolderStore.remove": ["mend.folder.remove", "remove organization folder"],
  // project
  "ProjectCreation.createNew": ["mend.project.create", "create named project"],
  "DependencyInstaller.install": [
    "mend.project.install_dependencies",
    "install project dependencies",
  ],
  "Removal.restore": ["mend.project.restore", "restore removed project"],
  "InstallRunner.run": ["mend.project.run_install_session", "run dependency install session"],
  // handoff
  "ConversationImport.importAs": ["mend.handoff.import_conversation", "import agent conversation"],
  "HandoffStart.provision": ["mend.handoff.provision_session", "provision handoff session"],
  "ConversationImport.land": ["mend.handoff.save_conversation", "save imported conversation"],
  "mend.store.sweep_handoff_quarantines": [
    "mend.handoff.sweep_quarantines",
    "remove stale handoff quarantines",
  ],
  // slack
  "ThreadProjectReader.read": ["mend.slack.choose_project", "choose project for thread"],
  "SlackRunner.runMention": ["mend.slack.handle_mention", "handle slack mention"],
  "SlackRunner.landFromThread": ["mend.slack.land_change", "land change from thread"],
  "SlackReporter.baseline": ["mend.slack.record_baseline", "record live thread baseline"],
  "mend.slack.reconcile_proof": [
    "mend.slack.requeue_proof_deliveries",
    "requeue pending proof deliveries",
  ],
  "SlackRunner.runLinked": ["mend.slack.run_linked_mention", "run mention after linking"],
  "SlackRunner.startFor": ["mend.slack.start_session", "start session from slack"],
  "SlackRunner.stopSwitched": ["mend.slack.stop_replaced_session", "stop replaced session"],
  "SlackReporter.look": ["mend.slack.update_thread", "update session slack thread"],
  // notification
  "SessionNotifier.observe": ["mend.notification.check_session", "check session for notifications"],
  "ExpoPushSender.send": ["mend.notification.send_push", "send expo push notifications"],
  // member
  "MemberRemoval.remove": ["mend.member.remove", "remove organization member"],
  "SshKeyRevoker.attempt": ["mend.member.revoke_ssh_keys", "revoke member ssh keys"],
  "SshKeyRevoker.sweep": ["mend.member.sweep_ssh_revocations", "sweep due ssh revocations"],
  // signer
  "AgentBridge.attach": ["mend.signer.connect", "connect key share signer"],
  // inference
  "InferenceProvider.respond": ["mend.inference.call_model", "run model exchange"],
  "InferenceProvider.runTool": ["mend.inference.run_tool", "run model tool call"],
  // mcp
  "CodexMcpApps.callTool": ["mend.mcp.call_app_tool", "call mcp app tool"],
  "CodexMcpApps.listTools": ["mend.mcp.list_app_tools", "list mcp app tools"],
  "CodexMcpApps.readResource": ["mend.mcp.read_app_resource", "read mcp app resource"],
  // sealant
  "PersonLayoutPlatform.sshAsOwnerFor": [
    "mend.sealant.bind_ssh_owner",
    "bind launcher for remote ssh",
  ],
  "BoatKeyFullChecks.run": ["mend.sealant.check_boat_key", "run full boat key check"],
  "SealantClient.connectionCheck": ["mend.sealant.check_connection", "check sealant connection"],
  "SealantClients.connect": ["mend.sealant.connect_account", "connect agent login account"],
  "SealantClient.createWorkspace": ["mend.sealant.create_workspace", "create sealant workspace"],
  "SealantClient.findWorkspaceByKey": [
    "mend.sealant.find_workspace",
    "find workspace by launch key",
  ],
  "SealantClients.inspectImage": ["mend.sealant.inspect_image", "inspect workspace image"],
  "SealantClient.openForward": ["mend.sealant.open_forward", "open workspace port forward"],
  "SealantClient.openSession": ["mend.sealant.open_session", "open sealant session"],
  "PersonLayoutPlatform.postCredentials": [
    "mend.sealant.put_credentials",
    "write logins through sealant",
  ],
  "SealantClient.captureStatus": [
    "mend.sealant.read_capture_status",
    "read sealant capture status",
  ],
  "SealantClient.recordCommands": ["mend.sealant.read_command_record", "read run command record"],
  "SealantClient.getRun": ["mend.sealant.read_run", "read sealant run"],
  "SealantClient.runChanges": ["mend.sealant.read_run_changes", "read run changes"],
  "SealantClient.recordScrollback": ["mend.sealant.read_scrollback", "read process scrollback"],
  "SealantClient.getSession": ["mend.sealant.read_session", "read sealant session"],
  "SealantClient.sessionOutput": [
    "mend.sealant.read_session_output",
    "read sealant session output",
  ],
  "SealantClient.getWorkspace": ["mend.sealant.read_workspace", "read sealant workspace"],
  "SealantClient.runHarness": ["mend.sealant.run_harness", "run harness to completion"],
  "PersonLayoutPlatform.sshAsRoot": ["mend.sealant.set_ssh_root", "set remote ssh to root"],
  "SealantClient.expireWorkspace": [
    "mend.sealant.set_workspace_expiry",
    "set sealant workspace expiry",
  ],
  "SealantClient.startHarness": ["mend.sealant.start_harness", "start harness run"],
  "SealantClient.startHarnessInWorkspace": ["mend.sealant.start_harness", "start harness run"],
  "SealantClient.stopWorkspace": ["mend.sealant.stop_workspace", "stop sealant workspace"],
  "SealantClient.waitRun": ["mend.sealant.wait_run", "wait for sealant run"],
  // gateway
  "GatewayAuth.authenticate": [
    "mend.gateway.authenticate_bearer",
    "authenticate gateway bearer token",
  ],
  "PersonHub.createProject": ["mend.gateway.create_project", "create project from gateway"],
  "GatewayAuth.exchange": ["mend.gateway.exchange_code", "exchange code for token"],
  "MendClient.connectedAccounts": [
    "mend.gateway.list_connected_accounts",
    "list connected agent logins",
  ],
  "AttachmentUploads.remove": ["mend.gateway.remove_image_upload", "remove uploaded image"],
  // github
  "GithubApi.get": ["mend.github.request", "request github rest api"],
  // job
  "JobRunner.enqueue": ["mend.job.enqueue", "enqueue job"],
  "mend.job.process": ["mend.job.process", "process queued job"],
  "JobRunner.work": ["mend.job.register_worker", "register queue worker"],
  // run
  "Dispatcher.run": ["mend.run.dispatch_issues", "run issue dispatcher"],
  "Dispatcher.tick": ["mend.run.poll_queued_issues", "poll queued issues"],
  "RunStarter.resume": ["mend.run.resume", "resume unsettled issue runs"],
  "RunStarter.startOnChange": ["mend.run.start_follow_up", "start follow-up issue run"],
  "RunStarter.startVerification": ["mend.run.start_verification", "start verification run"],
};

/**
 * Spans a library names inside Mend's processes, by the library's name for them: the same
 * convention, kept apart because no source of Mend's names them.
 */
export const LIBRARY_SPAN_NAMES: Readonly<
  Record<string, readonly [name: string, description: string]>
> = {
  // drizzle-orm's Effect driver, once as a process opens its database.
  "PgDrizzle.make": ["mend.db.open_client", "open database client"],
};
