/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../../nls.js';
import { AccessibleViewProviderId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { CONTEXT_ACCESSIBILITY_MODE_ENABLED } from '../../../../../platform/accessibility/common/accessibility.js';
import { ContextKeyExpr, IContextKeyService, type IContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import { accessibleViewCurrentProviderId, accessibleViewIsShown } from '../../../accessibility/browser/accessibilityConfiguration.js';
import type { ITerminalContribution, ITerminalInstance } from '../../../terminal/browser/terminal.js';
import { registerActiveInstanceAction, registerTerminalAction } from '../../../terminal/browser/terminalActions.js';
import { registerTerminalContribution } from '../../../terminal/browser/terminalExtensions.js';
import type { TerminalWidgetManager } from '../../../terminal/browser/widgets/widgetManager.js';
import { TerminalCommandId, type ITerminalProcessManager } from '../../../terminal/common/terminal.js';
import { TerminalContextKeys } from '../../../terminal/common/terminalContextKey.js';
import { clearShellFileHistory, getCommandHistory, getDirectoryHistory } from '../common/history.js';
import { showRunRecentQuickPick } from './terminalRunRecentQuickPick.js';

// #region Terminal Contributions

class TerminalHistoryContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.history';

	static get(instance: ITerminalInstance): TerminalHistoryContribution | null {
		return instance.getContribution<TerminalHistoryContribution>(TerminalHistoryContribution.ID);
	}

	private _terminalInRunCommandPicker: IContextKey<boolean>;

	constructor(
		private readonly _instance: ITerminalInstance,
		processManager: ITerminalProcessManager,
		widgetManager: TerminalWidgetManager,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();

		this._terminalInRunCommandPicker = TerminalContextKeys.inTerminalRunCommandPicker.bindTo(this._contextKeyService);

		this._register(this._instance.capabilities.onDidAddCapabilityType(e => {
			switch (e) {
				case TerminalCapability.CwdDetection: {
					this._instance.capabilities.get(TerminalCapability.CwdDetection)?.onDidChangeCwd(e => {
						this._instantiationService.invokeFunction(getDirectoryHistory)?.add(e, { remoteAuthority: this._instance.remoteAuthority });
					});
					break;
				}
				case TerminalCapability.CommandDetection: {
					this._instance.capabilities.get(TerminalCapability.CommandDetection)?.onCommandFinished(e => {
						if (e.command.trim().length > 0) {
							this._instantiationService.invokeFunction(getCommandHistory)?.add(e.command, { shellType: this._instance.shellType });
						}
					});
					break;
				}
			}
		}));
	}

	/**
	 * Triggers a quick pick that displays recent commands or cwds. Selecting one will
	 * rerun it in the active terminal.
	 */
	async runRecent(type: 'command' | 'cwd', filterMode?: 'fuzzy' | 'contiguous', value?: string): Promise<void> {
		return this._instantiationService.invokeFunction(showRunRecentQuickPick,
			this._instance,
			this._terminalInRunCommandPicker,
			type,
			filterMode,
			value
		);
	}
}

registerTerminalContribution(TerminalHistoryContribution.ID, TerminalHistoryContribution);

// #endregion

// #region Actions

const precondition = ContextKeyExpr.or(TerminalContextKeys.processSupported, TerminalContextKeys.terminalHasBeenCreated);

registerActiveInstanceAction({
	id: TerminalCommandId.RunRecentCommand,
	title: localize2('workbench.action.terminal.runRecentCommand', 'Run Recent Command...'),
	precondition,
	keybinding: [
		{
			primary: KeyMod.CtrlCmd | KeyCode.KeyR,
			when: ContextKeyExpr.and(CONTEXT_ACCESSIBILITY_MODE_ENABLED, ContextKeyExpr.or(TerminalContextKeys.focus, ContextKeyExpr.and(accessibleViewIsShown, accessibleViewCurrentProviderId.isEqualTo(AccessibleViewProviderId.Terminal)))),
			weight: KeybindingWeight.WorkbenchContrib
		},
		{
			primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyR,
			mac: { primary: KeyMod.WinCtrl | KeyMod.Alt | KeyCode.KeyR },
			when: ContextKeyExpr.and(TerminalContextKeys.focus, CONTEXT_ACCESSIBILITY_MODE_ENABLED.negate()),
			weight: KeybindingWeight.WorkbenchContrib
		}
	],
	run: async (activeInstance, c) => {
		const history = TerminalHistoryContribution.get(activeInstance);
		if (!history) {
			return;
		}
		await history.runRecent('command');
		if (activeInstance?.target === TerminalLocation.Editor) {
			await c.editorService.revealActiveEditor();
		} else {
			await c.groupService.showPanel(false);
		}
	}
});

// TODO: move command IDs into this file
registerActiveInstanceAction({
	id: TerminalCommandId.GoToRecentDirectory,
	title: localize2('workbench.action.terminal.goToRecentDirectory', 'Go to Recent Directory...'),
	metadata: {
		description: localize2('goToRecentDirectory.metadata', 'Goes to a recent folder'),
	},
	precondition,
	keybinding: {
		primary: KeyMod.CtrlCmd | KeyCode.KeyG,
		when: TerminalContextKeys.focus,
		weight: KeybindingWeight.WorkbenchContrib
	},
	run: async (activeInstance, c) => {
		const history = TerminalHistoryContribution.get(activeInstance);
		if (!history) {
			return;
		}
		await history.runRecent('cwd');
		if (activeInstance?.target === TerminalLocation.Editor) {
			await c.editorService.revealActiveEditor();
		} else {
			await c.groupService.showPanel(false);
		}
	}
});

registerTerminalAction({
	id: TerminalCommandId.ClearPreviousSessionHistory,
	title: localize2('workbench.action.terminal.clearPreviousSessionHistory', 'Clear Previous Session History'),
	precondition,
	run: async (c, accessor) => {
		getCommandHistory(accessor).clear();
		clearShellFileHistory();
	}
});


// #endregion
