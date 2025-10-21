(function () {
	'use strict';

	const BTN_CLASS = 'betterLabelEdit-publish';
	const LOG = (...a) => console.log('[multi-publish]', ...a);

	// --------- helpers ---------
	function getQid() {
		const q = mw.config.get('wbEntityId');
		if (q && /^Q\d+$/.test(q)) return q;
		const m = location.pathname.match(/\/(Q\d+)(?:[#/]|$)/);
		return m ? m[1] : null;
	}

	function closestLangCode(node) {
		if (!node) return null;
		const blk = node.closest?.('[data-language], [lang], .wikibase-entitytermsview-languageview, .wb-entity-terms') || node;
		return blk.getAttribute?.('data-language')
			|| blk.getAttribute?.('lang')
			|| blk.querySelector?.('[data-language]')?.getAttribute('data-language')
			|| blk.querySelector?.('[lang]')?.getAttribute('lang')
			|| null;
	}
	// Return Array if we can read aliases; return **null** if no aliases UI is present.
	// [] means "explicitly empty" (user cleared them).
	function aliasesFromBlock(block) {
		// --- Tagadata (legacy) ---
		const ul = block.querySelector('.wikibase-aliasesview-list.tagadata');
		if (ul) {
			const vals = [];
			// read all non-empty choices; skip the placeholder row
			const items = ul.querySelectorAll('li.tagadata-choice:not(.tagadata-choice-empty)');
			for (const li of items) {
				const input = li.querySelector('.tagadata-label input.tagadata-label-text');
				let v = '';
				if (input) {
					v = (input.value || '').trim();
				} else {
					// sometimes non-edit chips render as text
					v = (li.querySelector('.tagadata-label')?.textContent || '').trim();
				}
				if (v) vals.push(v);
			}
			// Dedupe while preserving order
			const seen = new Set(); const out = [];
			for (const v of vals) if (!seen.has(v)) { seen.add(v); out.push(v); }
			return out;                       // could be [] if user cleared
		}

		// --- OOUI TagMultiselect (newer widget) ---
		const tag = block.querySelector('.oo-ui-tagMultiselectWidget');
		if (tag) {
			const w = $(tag).data('oo-ui-widget');
			if (w && typeof w.getItems === 'function') {
				const items = w.getItems();
				const out = [];
				for (const it of items) {
					const label = typeof it.getLabel === 'function' ? it.getLabel() : it.label;
					const v = String(label || '').trim();
					if (v) out.push(v);
				}
				// dedupe
				const seen = new Set(); const uniq = [];
				for (const v of out) if (!seen.has(v)) { seen.add(v); uniq.push(v); }
				return uniq;                    // [] if cleared
			}
			return null;                      // widget exists but unreadable → do not touch aliases
		}

		// --- Fallback: plain text field inside aliases cell (rare on item page) ---
		const field = block.querySelector(
			'.wikibase-aliasesview textarea, .wikibase-aliasesview input,' +
			'textarea[name*="alias" i], input[name*="alias" i],' +
			'textarea[id*="alias" i], input[id*="alias" i]'
		);
		if (field) {
			const out = (field.value || '')
				.split(/\r?\n|;|,|\|/g).map(s => s.trim()).filter(Boolean);
			const seen = new Set(); const uniq = [];
			for (const v of out) if (!seen.has(v)) { seen.add(v); uniq.push(v); }
			return uniq;                      // [] if explicitly cleared
		}

		// No aliases UI detected → don't touch aliases for this language
		return null;
	}


	function dedupe(arr) {
		const seen = new Set(); const out = [];
		for (const v of arr) if (!seen.has(v)) { seen.add(v); out.push(v); }
		return out;
	}
	// Extract language from the TR class like "wikibase-entitytermsforlanguageview-en"
	function langFromRow(tr) {
		const m = tr.className.match(/wikibase-entitytermsforlanguageview-([a-z0-9-]+)/i);
		if (m) return m[1].toLowerCase();
		// fallback: any [lang] attribute in the row
		const attr = tr.getAttribute('lang') ||
			tr.querySelector('[lang]')?.getAttribute('lang') ||
			tr.querySelector('input[lang],textarea[lang]')?.getAttribute('lang');
		return (attr || mw.config.get('wgUserLanguage') || 'en').toLowerCase();
	}

	function textFromWidgetOrInput(root) {
		const widgetEl = root.closest?.('.oo-ui-textInputWidget') || root.querySelector?.('.oo-ui-textInputWidget');
		if (widgetEl) {
			const w = $(widgetEl).data('oo-ui-widget');
			if (w && typeof w.getValue === 'function') return (w.getValue() || '').trim();
		}
		const el = root.matches?.('input,textarea') ? root : root.querySelector('input,textarea');
		return (el?.value || '').trim();
	}

	// Scan only rows that are currently in edit mode (.wb-edit)
	function collectAllTerms() {
		var out = {}; // lang -> { label?, description?, aliases? }
		var rows = document.querySelectorAll('tr.wikibase-entitytermsforlanguageview.wb-edit');

		for (var i = 0; i < rows.length; i++) {
			var tr = rows[i];
			var lang = langFromRow(tr);

			// Ensure object exists for this language
			if (!out[lang]) out[lang] = {};

			// ---- label ----
			var labelRoot = tr.querySelector(
				'.wikibase-entitytermsforlanguageview-label .wikibase-labelview-input, ' +
				'.wikibase-entitytermsforlanguageview-label .oo-ui-textInputWidget input, ' +
				'.wikibase-entitytermsforlanguageview-label input'
			);
			if (labelRoot) {
				out[lang].label = textFromWidgetOrInput(labelRoot);
			}

			// ---- description ----
			var descRoot = tr.querySelector(
				'.wikibase-entitytermsforlanguageview-description .wikibase-descriptionview-input, ' +
				'.wikibase-entitytermsforlanguageview-description .oo-ui-textInputWidget input, ' +
				'.wikibase-entitytermsforlanguageview-description input'
			);
			if (descRoot) {
				out[lang].description = textFromWidgetOrInput(descRoot);
			}

			// ---- aliases ----
			var aliasCell = tr.querySelector('.wikibase-entitytermsforlanguageview-aliases .wikibase-aliasesview');
			var aliases = aliasCell ? aliasesFromBlock(aliasCell) : null;
			if (aliases !== null) {
				out[lang].aliases = aliases; // [] means explicit clear; null means untouched
			}
		}

		console.log('[multi-publish] collected per-row', out);
		return out;
	}

	// Build a diff; treat alias lists as **order-insensitive**.
	// We only write aliases for a lang if the key exists in editedByLang (i.e., we could read it).
	function buildDiffData(current, editedByLang) {
		const data = { labels: {}, descriptions: {}, aliases: {} };
		let changeCount = 0;

		const curLabels = current?.labels || {};
		const curDescs = current?.descriptions || {};
		const curAlias = current?.aliases || {};

		function sameAliasSet(a, b) {
			const A = (a || []).map(String);
			const B = (b || []).map(String);
			if (A.length !== B.length) return false;
			const sA = new Set(A);
			for (const x of B) if (!sA.has(x)) return false;
			return true;
		}

		for (const [lang, vals] of Object.entries(editedByLang)) {
			// Label (only if present in vals)
			if ('label' in vals) {
				const newVal = (vals.label || '').trim();
				const oldVal = curLabels[lang]?.value || '';
				if (newVal !== oldVal) {
					data.labels[lang] = { language: lang, value: newVal }; // empty string removes label
					changeCount++;
				}
			}

			// Description (only if present in vals)
			if ('description' in vals) {
				const newVal = (vals.description || '').trim();
				const oldVal = curDescs[lang]?.value || '';
				if (newVal !== oldVal) {
					data.descriptions[lang] = { language: lang, value: newVal }; // empty removes description
					changeCount++;
				}
			}

			// Aliases (only if we read them → key exists)
			if ('aliases' in vals) {
				const newList = Array.isArray(vals.aliases) ? vals.aliases : [];
				const oldList = (curAlias[lang] || []).map(x => x.value);
				if (!sameAliasSet(newList, oldList)) {
					data.aliases[lang] = newList.map(v => ({ language: lang, value: v })); // [] clears aliases
					changeCount++;
				}
			}
		}

		if (!Object.keys(data.labels).length) delete data.labels;
		if (!Object.keys(data.descriptions).length) delete data.descriptions;
		if (!Object.keys(data.aliases).length) delete data.aliases;

		return { data, changeCount };
	}

	function setDisabled(wrapper, disabled) {
		const a = wrapper.querySelector('a');
		if (disabled) {
			wrapper.classList.add('wikibase-toolbarbutton-disabled', 'ui-state-disabled');
			wrapper.setAttribute('aria-disabled', 'true');
			a.setAttribute('tabindex', '-1');
			a.style.pointerEvents = 'none';
		} else {
			wrapper.classList.remove('wikibase-toolbarbutton-disabled', 'ui-state-disabled');
			wrapper.removeAttribute('aria-disabled');
			a.removeAttribute('tabindex');
			a.style.pointerEvents = '';
		}
	}

	// --------- button placement ---------
	function ensureButton(beforeNode) {
		if (!beforeNode || beforeNode.previousElementSibling?.classList?.contains(BTN_CLASS)) return;

		const wrap = document.createElement('span');
		wrap.className = `wikibase-toolbar-item wikibase-toolbar-button ${BTN_CLASS}`;
		const a = document.createElement('a');
		a.href = '#';
		const span = document.createElement('span');
		span.classList = 'wb-icon';
		span.style.background = 'var(--color-base,#202122)';
		span.style.maskImage = 'url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2220%22 height=%2220%22 viewBox=%220 0 20 20%22%3E %3Ctitle%3E check %3C/title%3E %3Cpath d=%22M7 14.17L2.83 10l-1.41 1.41L7 17 19 5l-1.41-1.42L7 14.17z%22/%3E %3C/svg%3E")';
		a.appendChild(span);
		wrap.appendChild(a);
		wrap.title = 'Save label/description/aliases across all edited languages in one edit';

		a.addEventListener('click', function (ev) {
			ev.preventDefault(); ev.stopPropagation();

			const qid = getQid();
			if (!qid) return mw.notify('Cannot detect entity ID (Q-id).', { type: 'error' });

			const edited = collectAllTerms();

			mw.loader.using('mediawiki.api').then(() => {
				const api = new mw.Api();
				// Fetch current terms to compute a diff (so we don’t send no-ops)
				return api.get({
					action: 'wbgetentities',
					ids: qid,
					props: 'labels|descriptions|aliases',
					// languages omitted -> returns all languages
					format: 'json'
				}).then(res => {
					const entity = res?.entities?.[qid] || {};
					const { data, changeCount } = buildDiffData(entity, edited);

					LOG('diff to send', data, 'changes:', changeCount);
					if (!changeCount) {
						return mw.notify('Nothing changed — no edits to publish.', { type: 'warn' });
					}

					setDisabled(wrap, true);
					return api.postWithEditToken({
						action: 'wbeditentity',
						id: qid,
						data: JSON.stringify(data),
						summary: '',
						maxlag: 5,
						format: 'json'
					}).then(() => {
						mw.notify('Saved all edited languages in one edit.', { type: 'success' });
						location.reload();
					}).catch(e => {
						const msg = (e?.error && (e.error.info || e.error.code)) || e?.message || String(e);
						mw.notify('Save failed: ' + msg, { type: 'error', autoHide: false });
						console.error('[multi-publish] save failed', e);
					}).finally(() => setDisabled(wrap, false));
				});
			});
		}, { capture: true });

		beforeNode.parentNode.insertBefore(wrap, beforeNode);
		LOG('inserted multi-language button before', beforeNode);
	}

	function findPublishWrapper(root = document) {
		let el = root.querySelector('.wikibase-toolbar-button-save');
		if (el) return el;
		// Fallback by text
		for (const a of root.querySelectorAll('.wikibase-toolbar a, .wikibase-toolbarbutton a, .wikibase-toolbar-button a')) {
			const t = (a.textContent || '').trim().toLowerCase();
			if (t === 'publish' || t === 'save' || t === 'save changes') {
				return a.closest('.wikibase-toolbarbutton, .wikibase-toolbar-button') || a.parentElement;
			}
		}
		return null;
	}

	// Try to insert the button into the given view root (or search all views if none provided)
	function tryInsert(viewRoot) {
		if (viewRoot) {
			const saveWrap = findPublishWrapper(viewRoot);
			if (saveWrap) { ensureButton(saveWrap); return true; }
			return false;
		}

		// No specific root provided — only consider elements inside .wikibase-entitytermsview
		const views = document.querySelectorAll('.wikibase-entitytermsview');
		for (const v of views) {
			if (tryInsert(v)) return true;
		}
		return false;
	}

	function init() {
		if (tryInsert()) return;

		// Observe entering edit mode on the item page
		const obs = new MutationObserver(muts => {
			for (const m of muts) {
				if (m.type === 'childList') {
					for (const n of m.addedNodes) {
						if (!(n instanceof HTMLElement)) continue;
						// Only react to nodes that are inside a .wikibase-entitytermsview root
						const rootView = n.closest('.wikibase-entitytermsview');
						if (!rootView) continue;
						// If this view looks like it contains the save wrapper, try inserting only inside it
						if (rootView.querySelector('.wikibase-toolbar-button-save') || n.matches('.wikibase-toolbar-button-save')) {
							if (tryInsert(rootView)) return;
						}
					}
				}
			}
		});
		obs.observe(document.body, { childList: true, subtree: true });

		// Safety polling
		let tries = 0;
		const id = setInterval(() => { if (tryInsert() || ++tries > 20) clearInterval(id); }, 300);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
