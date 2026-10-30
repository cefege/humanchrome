/* @ts-self-types="./humanchrome_wasm.d.ts" */

/**
 * Stateful, effect-free browser policy handle. Chrome probes, timers, and Promise settlement
 * remain in the host; continuations are retained here so a liveness resume cannot re-resolve a
 * different active tab.
 */
export class RustBrowserState {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RustBrowserStateFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rustbrowserstate_free(ptr, 0);
    }
    /**
     * Returns raw queue entries through the extension's existing test escape hatch.
     * @param {bigint} tab_id
     * @returns {string}
     */
    _queue_entries_for_test(tab_id) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.rustbrowserstate__queue_entries_for_test(this.__wbg_ptr, tab_id);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Clears queues through the extension's existing test reset hook.
     */
    _reset_queues_for_test() {
        wasm.rustbrowserstate__reset_queues_for_test(this.__wbg_ptr);
    }
    /**
     * Sets the queue hold estimator through the extension's test escape hatch.
     * @param {bigint} tab_id
     * @param {bigint} mean_hold_ms
     */
    _set_queue_mean_hold_for_test(tab_id, mean_hold_ms) {
        wasm.rustbrowserstate__set_queue_mean_hold_for_test(this.__wbg_ptr, tab_id, mean_hold_ms);
    }
    /**
     * Returns the number of active tab queues.
     * @returns {number}
     */
    active_locked_tab_count() {
        const ret = wasm.rustbrowserstate_active_locked_tab_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Admits one call to a per-tab queue.
     * @param {bigint} tab_id
     * @param {string} client_id_json
     * @param {string} timeout_json
     * @param {bigint} now
     * @returns {string}
     */
    admit_tab_lock(tab_id, client_id_json, timeout_json, now) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(client_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(timeout_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.rustbrowserstate_admit_tab_lock(this.__wbg_ptr, tab_id, ptr0, len0, ptr1, len1, now);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * Returns aliases in insertion order.
     * @param {string} client_id_json
     * @returns {string}
     */
    aliases(client_id_json) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(client_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.rustbrowserstate_aliases(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Claims a tab and returns its former owner or JSON null.
     * @param {string} client_id_json
     * @param {bigint} tab_id
     * @param {string} window_id_json
     * @param {bigint} now
     * @returns {string}
     */
    claim_tab(client_id_json, tab_id, window_id_json, now) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(client_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(window_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.rustbrowserstate_claim_tab(this.__wbg_ptr, ptr0, len0, tab_id, ptr1, len1, now);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * Clamps a requested tab-lock timeout using the existing dispatcher bounds.
     * @param {string} timeout_json
     * @returns {string}
     */
    static clamp_tab_lock_timeout(timeout_json) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(timeout_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.rustbrowserstate_clamp_tab_lock_timeout(ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Clears an invalid cached window hint.
     * @param {string} client_id_json
     * @param {bigint} window_id
     * @returns {boolean}
     */
    clear_last_window(client_id_json, window_id) {
        const ptr0 = passStringToWasm0(client_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustbrowserstate_clear_last_window(this.__wbg_ptr, ptr0, len0, window_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Returns a diagnostic client state or JSON null.
     * @param {string} client_id_json
     * @returns {string}
     */
    client_snapshot(client_id_json) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(client_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.rustbrowserstate_client_snapshot(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Cancels all callbacks associated with a closed tab queue.
     * @param {bigint} tab_id
     * @returns {string}
     */
    close_tab_queue(tab_id) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.rustbrowserstate_close_tab_queue(this.__wbg_ptr, tab_id);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Consumes a pacing delay using the host clock and random sample.
     * @param {string} client_id_json
     * @param {bigint} now
     * @param {number} random_sample
     * @returns {bigint}
     */
    consume_pacing_delay(client_id_json, now, random_sample) {
        const ptr0 = passStringToWasm0(client_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustbrowserstate_consume_pacing_delay(this.__wbg_ptr, ptr0, len0, now, random_sample);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * Returns the Rust-owned default timeout for per-tab queue admission.
     * @returns {bigint}
     */
    static default_tab_lock_timeout() {
        const ret = wasm.rustbrowserstate_default_tab_lock_timeout();
        return ret;
    }
    /**
     * Evicts stale client records.
     * @param {bigint} now
     * @returns {number}
     */
    evict_stale_clients(now) {
        const ret = wasm.rustbrowserstate_evict_stale_clients(this.__wbg_ptr, now);
        return ret >>> 0;
    }
    /**
     * Applies a Chrome tab-close notification.
     * @param {bigint} tab_id
     * @returns {boolean}
     */
    handle_tab_removed(tab_id) {
        const ret = wasm.rustbrowserstate_handle_tab_removed(this.__wbg_ptr, tab_id);
        return ret !== 0;
    }
    /**
     * Applies a Chrome window-close notification.
     * @param {bigint} window_id
     * @returns {boolean}
     */
    handle_window_removed(window_id) {
        const ret = wasm.rustbrowserstate_handle_window_removed(this.__wbg_ptr, window_id);
        return ret !== 0;
    }
    /**
     * Returns all queue inspector records in insertion order.
     * @param {bigint} now
     * @returns {string}
     */
    inspect_all_tab_queues(now) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.rustbrowserstate_inspect_all_tab_queues(this.__wbg_ptr, now);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Returns one camel-case queue inspector record or JSON null.
     * @param {bigint} tab_id
     * @param {bigint} now
     * @returns {string}
     */
    inspect_tab_queue(tab_id, now) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.rustbrowserstate_inspect_tab_queue(this.__wbg_ptr, tab_id, now);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Validates the alias grammar without lossy UTF-8 conversion.
     * @param {string} alias_json
     * @returns {boolean}
     */
    static is_valid_alias(alias_json) {
        const ptr0 = passStringToWasm0(alias_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustbrowserstate_is_valid_alias(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Marks the last host persistence write complete.
     */
    mark_persisted() {
        wasm.rustbrowserstate_mark_persisted(this.__wbg_ptr);
    }
    /**
     * Creates an empty browser policy state.
     */
    constructor() {
        const ret = wasm.rustbrowserstate_new();
        this.__wbg_ptr = ret;
        RustBrowserStateFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Returns the lossless `chrome.storage.session` ownership payload.
     * @returns {string}
     */
    ownership_snapshot() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.rustbrowserstate_ownership_snapshot(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Returns transient pacing state or JSON null.
     * @param {string} client_id_json
     * @returns {string}
     */
    pacing(client_id_json) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(client_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.rustbrowserstate_pacing(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Returns whether the host should schedule its debounced persistence write.
     * @returns {boolean}
     */
    persistence_dirty() {
        const ret = wasm.rustbrowserstate_persistence_dirty(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Creates a dispatch plan. `needsLivenessProbe` retains an opaque continuation handle.
     * @param {string} request_json
     * @param {bigint} now
     * @returns {string}
     */
    plan_dispatch(request_json, now) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.rustbrowserstate_plan_dispatch(this.__wbg_ptr, ptr0, len0, now);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Records a successful tab touch.
     * @param {string} client_id_json
     * @param {bigint} tab_id
     * @param {string} window_id_json
     * @param {bigint} now
     */
    record_client_tab(client_id_json, tab_id, window_id_json, now) {
        const ptr0 = passStringToWasm0(client_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(window_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.rustbrowserstate_record_client_tab(this.__wbg_ptr, ptr0, len0, tab_id, ptr1, len1, now);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Records a successful window-only touch.
     * @param {string} client_id_json
     * @param {bigint} window_id
     * @param {bigint} now
     */
    record_client_window(client_id_json, window_id, now) {
        const ptr0 = passStringToWasm0(client_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustbrowserstate_record_client_window(this.__wbg_ptr, ptr0, len0, window_id, now);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Releases all tabs for a disconnected client.
     * @param {string} client_id_json
     * @param {bigint} now
     * @returns {number}
     */
    release_client(client_id_json, now) {
        const ptr0 = passStringToWasm0(client_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustbrowserstate_release_client(this.__wbg_ptr, ptr0, len0, now);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Releases an owned tab without closing it.
     * @param {string} client_id_json
     * @param {bigint} tab_id
     * @returns {boolean}
     */
    release_tab(client_id_json, tab_id) {
        const ptr0 = passStringToWasm0(client_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustbrowserstate_release_tab(this.__wbg_ptr, ptr0, len0, tab_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Releases one held queue ticket idempotently.
     * @param {bigint} tab_id
     * @param {bigint} ticket
     * @param {bigint} now
     * @returns {string}
     */
    release_tab_lock(tab_id, ticket, now) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.rustbrowserstate_release_tab_lock(this.__wbg_ptr, tab_id, ticket, now);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Resolves an alias, retaining lone surrogates in errors.
     * @param {string} client_id_json
     * @param {string} alias_json
     * @returns {string}
     */
    resolve_alias(client_id_json, alias_json) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(client_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(alias_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.rustbrowserstate_resolve_alias(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * Resolves an owned-tab request and returns a target resolution/error document.
     * @param {string} client_id_json
     * @param {string} explicit_tab_id_json
     * @param {string} access_json
     * @param {bigint} now
     * @returns {string}
     */
    resolve_owned_tab(client_id_json, explicit_tab_id_json, access_json, now) {
        let deferred5_0;
        let deferred5_1;
        try {
            const ptr0 = passStringToWasm0(client_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(explicit_tab_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passStringToWasm0(access_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len2 = WASM_VECTOR_LEN;
            const ret = wasm.rustbrowserstate_resolve_owned_tab(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, now);
            var ptr4 = ret[0];
            var len4 = ret[1];
            if (ret[3]) {
                ptr4 = 0; len4 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred5_0 = ptr4;
            deferred5_1 = len4;
            return getStringFromWasm0(ptr4, len4);
        } finally {
            wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
        }
    }
    /**
     * Resolves the explicit or retained window hint.
     * @param {string} client_id_json
     * @param {string} explicit_window_id_json
     * @returns {string}
     */
    resolve_owned_window(client_id_json, explicit_window_id_json) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(client_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(explicit_window_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.rustbrowserstate_resolve_owned_window(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * Resolves the complete dispatcher target contract.
     * @param {string} request_json
     * @param {bigint} now
     * @returns {string}
     */
    resolve_target(request_json, now) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.rustbrowserstate_resolve_target(this.__wbg_ptr, ptr0, len0, now);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Restores ownership from a JSON payload and optional live Chrome tab ids.
     * @param {string} snapshot_json
     * @param {string} alive_tab_ids_json
     * @param {bigint} now
     * @returns {string}
     */
    restore_ownership(snapshot_json, alive_tab_ids_json, now) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(snapshot_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(alive_tab_ids_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.rustbrowserstate_restore_ownership(this.__wbg_ptr, ptr0, len0, ptr1, len1, now);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * Resumes the exact liveness continuation originally returned by [`Self::plan_dispatch`].
     * @param {number} continuation_id
     * @param {string} liveness_json
     * @returns {string}
     */
    resume_dispatch(continuation_id, liveness_json) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(liveness_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.rustbrowserstate_resume_dispatch(this.__wbg_ptr, continuation_id, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Sets an alias after the host performs its existing schema/ownership gates.
     * @param {string} client_id_json
     * @param {string} alias_json
     * @param {bigint} tab_id
     * @param {bigint} now
     * @returns {string}
     */
    set_alias(client_id_json, alias_json, tab_id, now) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(client_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(alias_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.rustbrowserstate_set_alias(this.__wbg_ptr, ptr0, len0, ptr1, len1, tab_id, now);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * Sets transient client pacing from a profile and optional override object.
     * @param {string} client_id_json
     * @param {string} profile_json
     * @param {string} overrides_json
     * @param {bigint} now
     * @returns {string}
     */
    set_pacing(client_id_json, profile_json, overrides_json, now) {
        let deferred5_0;
        let deferred5_1;
        try {
            const ptr0 = passStringToWasm0(client_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(profile_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passStringToWasm0(overrides_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len2 = WASM_VECTOR_LEN;
            const ret = wasm.rustbrowserstate_set_pacing(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, now);
            var ptr4 = ret[0];
            var len4 = ret[1];
            if (ret[3]) {
                ptr4 = 0; len4 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred5_0 = ptr4;
            deferred5_1 = len4;
            return getStringFromWasm0(ptr4, len4);
        } finally {
            wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
        }
    }
    /**
     * Returns a tab's owner or JSON null.
     * @param {bigint} tab_id
     * @returns {string}
     */
    tab_owner(tab_id) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.rustbrowserstate_tab_owner(this.__wbg_ptr, tab_id);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Applies a host queue timeout.
     * @param {bigint} tab_id
     * @param {bigint} ticket
     * @param {bigint} now
     * @param {bigint} timeout_ms
     * @returns {string}
     */
    timeout_tab_lock(tab_id, ticket, now, timeout_ms) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.rustbrowserstate_timeout_tab_lock(this.__wbg_ptr, tab_id, ticket, now, timeout_ms);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) RustBrowserState.prototype[Symbol.dispose] = RustBrowserState.prototype.free;

/**
 * Stateful snap policy retaining one DOM-collected anchor batch for a resize gesture.
 */
export class RustEditorSnapState {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RustEditorSnapStateFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rusteditorsnapstate_free(ptr, 0);
    }
    /**
     * Computes one frame using retained anchors and locks without a JSON round trip.
     * @param {any} input
     * @returns {any}
     */
    compute(input) {
        const ret = wasm.rusteditorsnapstate_compute(this.__wbg_ptr, input);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Computes labels from the retained locks without copying the anchor collection.
     * @param {any} input
     * @returns {any}
     */
    distance_labels(input) {
        const ret = wasm.rusteditorsnapstate_distance_labels(this.__wbg_ptr, input);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Creates an empty gesture state.
     */
    constructor() {
        const ret = wasm.rusteditorsnapstate_new();
        this.__wbg_ptr = ret;
        RustEditorSnapStateFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Stores one DOM-collected anchor batch and clears the previous gesture locks.
     * @param {any} anchors
     */
    set_targets(anchors) {
        const ret = wasm.rusteditorsnapstate_set_targets(this.__wbg_ptr, anchors);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) RustEditorSnapState.prototype[Symbol.dispose] = RustEditorSnapState.prototype.free;

/**
 * Stateful embedding-cache policy retaining opaque JavaScript payload handles.
 *
 * Keys cross this boundary as JSON string literals so unpaired UTF-16 surrogates are retained in
 * the core [`humanchrome_core::arguments::JsString`] representation. Values stay as JavaScript
 * handles: returning or evicting one changes handle ownership only and never copies a typed-array
 * embedding into WebAssembly memory.
 */
export class RustEmbeddingCache {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RustEmbeddingCacheFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rustembeddingcache_free(ptr, 0);
    }
    /**
     * Returns the legacy normalized capacity.
     * @returns {number}
     */
    get capacity() {
        const ret = wasm.rustembeddingcache_capacity(this.__wbg_ptr);
        return ret;
    }
    /**
     * Drops every payload handle and resets the recency list.
     */
    clear() {
        wasm.rustembeddingcache_clear(this.__wbg_ptr);
    }
    /**
     * Returns a cached payload or JavaScript `null` after applying a host-supplied access time.
     * @param {string} key_json
     * @param {number} now
     * @returns {any}
     */
    get(key_json, now) {
        const ptr0 = passStringToWasm0(key_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustembeddingcache_get(this.__wbg_ptr, ptr0, len0, now);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Tests for a payload without changing recency, frequency, or access time.
     * @param {string} key_json
     * @returns {boolean}
     */
    has(key_json) {
        const ptr0 = passStringToWasm0(key_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustembeddingcache_has(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Creates a cache using the legacy capacity fallback behavior.
     * @param {number} capacity
     */
    constructor(capacity) {
        const ret = wasm.rustembeddingcache_new(capacity);
        this.__wbg_ptr = ret;
        RustEmbeddingCacheFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Stores a payload handle using a host-supplied creation time and JavaScript's `Math.log`.
     * @param {string} key_json
     * @param {any} value
     * @param {number} now
     */
    set(key_json, value, now) {
        const ptr0 = passStringToWasm0(key_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustembeddingcache_set(this.__wbg_ptr, ptr0, len0, value, now);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns the number of retained payload handles.
     * @returns {number}
     */
    get size() {
        const ret = wasm.rustembeddingcache_size(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Returns the legacy `size / capacity` ratio.
     * @returns {number}
     */
    get usage() {
        const ret = wasm.rustembeddingcache_usage(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) RustEmbeddingCache.prototype[Symbol.dispose] = RustEmbeddingCache.prototype.free;

/**
 * Stateful Rust breakpoint policy for one active run.
 */
export class RustRunBreakpoints {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RustRunBreakpointsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rustrunbreakpoints_free(ptr, 0);
    }
    /**
     * Adds or enables a breakpoint.
     * @param {string} node_id_json
     */
    add(node_id_json) {
        const ptr0 = passStringToWasm0(node_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustrunbreakpoints_add(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns all breakpoints in insertion order.
     * @returns {string}
     */
    all() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.rustrunbreakpoints_all(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Clears all breakpoint state.
     */
    clear() {
        wasm.rustrunbreakpoints_clear(this.__wbg_ptr);
    }
    /**
     * Disables one existing breakpoint.
     * @param {string} node_id_json
     */
    disable(node_id_json) {
        const ptr0 = passStringToWasm0(node_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustrunbreakpoints_disable(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Enables one existing breakpoint.
     * @param {string} node_id_json
     */
    enable(node_id_json) {
        const ptr0 = passStringToWasm0(node_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustrunbreakpoints_enable(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns enabled node identifiers in insertion order.
     * @returns {string}
     */
    enabled() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.rustrunbreakpoints_enabled(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Returns whether one breakpoint is enabled.
     * @param {string} node_id_json
     * @returns {boolean}
     */
    has_breakpoint(node_id_json) {
        const ptr0 = passStringToWasm0(node_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustrunbreakpoints_has_breakpoint(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Creates the run's breakpoint state from an optional JSON node-id array.
     * @param {string | null} [node_ids_json]
     */
    constructor(node_ids_json) {
        var ptr0 = isLikeNone(node_ids_json) ? 0 : passStringToWasm0(node_ids_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustrunbreakpoints_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        RustRunBreakpointsFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Removes a breakpoint.
     * @param {string} node_id_json
     */
    remove(node_id_json) {
        const ptr0 = passStringToWasm0(node_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustrunbreakpoints_remove(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Replaces every breakpoint.
     * @param {string} node_ids_json
     */
    set_all(node_ids_json) {
        const ptr0 = passStringToWasm0(node_ids_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustrunbreakpoints_set_all(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Enables or clears one-shot step-over behavior.
     * @param {boolean} enabled
     */
    set_step_over(enabled) {
        wasm.rustrunbreakpoints_set_step_over(this.__wbg_ptr, enabled);
    }
    /**
     * Returns whether this node should pause execution.
     * @param {string} node_id_json
     * @returns {boolean}
     */
    should_pause_at(node_id_json) {
        const ptr0 = passStringToWasm0(node_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rustrunbreakpoints_should_pause_at(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Returns whether one-shot step-over is active.
     * @returns {boolean}
     */
    step_over() {
        const ret = wasm.rustrunbreakpoints_step_over(this.__wbg_ptr);
        return ret !== 0;
    }
}
if (Symbol.dispose) RustRunBreakpoints.prototype[Symbol.dispose] = RustRunBreakpoints.prototype.free;

/**
 * Rust-owned stateful admission policy for one V3 trigger manager.
 */
export class RustTriggerAdmission {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        RustTriggerAdmissionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_rusttriggeradmission_free(ptr, 0);
    }
    /**
     * Admits or drops one host-observed fire without enqueueing a run itself.
     * @param {string} trigger_id_json
     * @param {number} now_ms
     * @param {number} queued_count
     * @returns {string}
     */
    admit(trigger_id_json, now_ms, queued_count) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(trigger_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.rusttriggeradmission_admit(this.__wbg_ptr, ptr0, len0, now_ms, queued_count);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Clears every installed identity before the host refreshes handlers.
     */
    clear_installed() {
        wasm.rusttriggeradmission_clear_installed(this.__wbg_ptr);
    }
    /**
     * Reports terminal enqueue success or failure, rolling back cooldown only on failure.
     * @param {number} ticket
     * @param {boolean} succeeded
     */
    finish(ticket, succeeded) {
        const ret = wasm.rusttriggeradmission_finish(this.__wbg_ptr, ticket, succeeded);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns whether the host must observe its persisted queue length.
     * @returns {boolean}
     */
    has_queue_cap() {
        const ret = wasm.rusttriggeradmission_has_queue_cap(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Marks one host-successfully-installed trigger as eligible to fire.
     * @param {string} trigger_id_json
     */
    install(trigger_id_json) {
        const ptr0 = passStringToWasm0(trigger_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rusttriggeradmission_install(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns successfully installed trigger identities in insertion order.
     * @returns {string}
     */
    installed_ids() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.rusttriggeradmission_installed_ids(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Returns whether the manager is started.
     * @returns {boolean}
     */
    is_started() {
        const ret = wasm.rusttriggeradmission_is_started(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Validates storm control and creates a stopped admission state.
     * @param {any} cooldown_ms
     * @param {any} max_queued
     */
    constructor(cooldown_ms, max_queued) {
        const ret = wasm.rusttriggeradmission_new(cooldown_ms, max_queued);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        RustTriggerAdmissionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Starts fire admission.
     */
    start() {
        wasm.rusttriggeradmission_start(this.__wbg_ptr);
    }
    /**
     * Stops admission and removes installed identities and cooldown stamps.
     */
    stop() {
        wasm.rusttriggeradmission_stop(this.__wbg_ptr);
    }
    /**
     * Removes an uninstalled trigger identity.
     * @param {string} trigger_id_json
     */
    uninstall(trigger_id_json) {
        const ptr0 = passStringToWasm0(trigger_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.rusttriggeradmission_uninstall(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) RustTriggerAdmission.prototype[Symbol.dispose] = RustTriggerAdmission.prototype.free;

/**
 * Rust-owned document mapping and label reservation state.
 */
export class SemanticIndex {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SemanticIndexFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_semanticindex_free(ptr, 0);
    }
    /**
     * Reconciles the next label after the retained HNSW index has been opened.
     * @param {number} index_count
     */
    apply_initialized_index_count(index_count) {
        wasm.semanticindex_apply_initialized_index_count(this.__wbg_ptr, index_count);
    }
    /**
     * Computes LRU and time-retention decisions with host-supplied time.
     * @param {number} max_elements
     * @param {number | null | undefined} max_retention_days
     * @param {bigint} now_ms
     * @returns {string}
     */
    auto_cleanup_plan(max_elements, max_retention_days, now_ms) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.semanticindex_auto_cleanup_plan(this.__wbg_ptr, max_elements, !isLikeNone(max_retention_days), isLikeNone(max_retention_days) ? 0 : max_retention_days, now_ms);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Clears duplicate-page state during a full index or model clear.
     */
    clear_indexed_pages() {
        wasm.semanticindex_clear_indexed_pages(this.__wbg_ptr);
    }
    /**
     * Moves one contiguous embedding into the owned mapping after successful host ANN insertion.
     * @param {number} label
     * @param {string} document_json
     * @param {Float32Array} embedding
     */
    commit_document(label, document_json, embedding) {
        const ptr0 = passStringToWasm0(document_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(embedding, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.semanticindex_commit_document(this.__wbg_ptr, label, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns the number of persisted document mappings without projecting their embeddings.
     * @returns {number}
     */
    document_count() {
        const ret = wasm.semanticindex_document_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Checks the exact raw URL/title duplicate key in Rust-owned indexing state.
     * @param {string} url_json
     * @param {string} title_json
     * @returns {boolean}
     */
    has_indexed_page(url_json, title_json) {
        const ptr0 = passStringToWasm0(url_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(title_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.semanticindex_has_indexed_page(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Returns the browser-visible number of remembered duplicate keys.
     * @returns {number}
     */
    indexed_page_count() {
        const ret = wasm.semanticindex_indexed_page_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Records a page only after its selected chunks have been offered to the host.
     * @param {string} url_json
     * @param {string} title_json
     */
    mark_indexed_page(url_json, title_json) {
        const ptr0 = passStringToWasm0(url_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(title_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.semanticindex_mark_indexed_page(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Moves a contiguous normalized output batch to JavaScript after retained ONNX pooling.
     * @param {Float32Array} hidden_state
     * @param {Int32Array} attention_mask
     * @param {number} batch_size
     * @param {number} sequence_length
     * @param {number} hidden_size
     * @returns {Float32Array}
     */
    mean_pool_normalized(hidden_state, attention_mask, batch_size, sequence_length, hidden_size) {
        const ptr0 = passArrayF32ToWasm0(hidden_state, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(attention_mask, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.semanticindex_mean_pool_normalized(this.__wbg_ptr, ptr0, len0, ptr1, len1, batch_size, sequence_length, hidden_size);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v3 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v3;
    }
    /**
     * Creates an empty mapping. The host retains HNSW and persistence effects.
     */
    constructor() {
        const ret = wasm.semanticindex_new();
        this.__wbg_ptr = ret;
        SemanticIndexFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Removes one mapping and returns its persisted document when present.
     * @param {number} label
     * @returns {string | undefined}
     */
    remove_label(label) {
        const ret = wasm.semanticindex_remove_label(this.__wbg_ptr, label);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Removes all document mappings for a tab and returns labels for host HNSW deletion.
     * @param {bigint} tab_id
     * @returns {string}
     */
    remove_tab(tab_id) {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.semanticindex_remove_tab(this.__wbg_ptr, tab_id);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Reserves an HNSW label before the host adds its vector.
     * @returns {number}
     */
    reserve_label() {
        const ret = wasm.semanticindex_reserve_label(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Restores the existing persisted `documents`, `tabDocuments`, and `nextLabel` shape.
     * @param {string} persisted_json
     */
    restore(persisted_json) {
        const ptr0 = passStringToWasm0(persisted_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.semanticindex_restore(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Maps HNSW neighbors, applies top-50-before-dedup, and returns the browser's top ten rows.
     * @param {string} neighbors_json
     * @returns {string}
     */
    search_results(neighbors_json) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(neighbors_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.semanticindex_search_results(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Serializes the existing mapping format without serializing embeddings through a host copy.
     * @returns {string}
     */
    snapshot() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.semanticindex_snapshot(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Returns the number of tab-to-label mappings without projecting document metadata.
     * @returns {number}
     */
    tab_count() {
        const ret = wasm.semanticindex_tab_count(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) SemanticIndex.prototype[Symbol.dispose] = SemanticIndex.prototype.free;

/**
 * Reusable indexed flow plus variable context held entirely in the WASM realm.
 */
export class WorkflowHandle {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WorkflowHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_workflowhandle_free(ptr, 0);
    }
    /**
     * Applies ordered set/delete operations without rebuilding the indexed flow.
     * @param {string} operations_json
     */
    apply_variable_operations(operations_json) {
        const ptr0 = passStringToWasm0(operations_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.workflowhandle_apply_variable_operations(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Applies host-decided variable patches without rebuilding the indexed graph.
     * @param {string} patch_json
     */
    apply_variable_patch(patch_json) {
        const ptr0 = passStringToWasm0(patch_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.workflowhandle_apply_variable_patch(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Returns the first depth-first cycle path, including its repeated terminal node.
     * @returns {string}
     */
    detect_cycle() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.workflowhandle_detect_cycle(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Returns the source position of the first outgoing edge carrying `label`.
     * @param {string} node_id
     * @param {string} label_json
     * @returns {number | undefined}
     */
    edge_index_by_label(node_id, label_json) {
        const ptr0 = passStringToWasm0(node_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(label_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.workflowhandle_edge_index_by_label(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] === Number.MAX_SAFE_INTEGER ? undefined : ret[0];
    }
    /**
     * Returns incoming edge source positions so the host can retain original edge objects.
     * @param {string} node_id
     * @returns {string}
     */
    in_edge_indices(node_id) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(node_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.workflowhandle_in_edge_indices(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Parses a V3 flow and variables once for repeated traversal and resolution decisions.
     * @param {string} flow_json
     * @param {string} variables_json
     */
    constructor(flow_json, variables_json) {
        const ptr0 = passStringToWasm0(flow_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(variables_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.workflowhandle_new(ptr0, len0, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        WorkflowHandleFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Chooses the next node using label/default/sole-edge precedence without graph reserialization.
     * @param {string} node_id
     * @param {string | null} [label_json]
     * @returns {string | undefined}
     */
    next_node(node_id, label_json) {
        const ptr0 = passStringToWasm0(node_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        var ptr1 = isLikeNone(label_json) ? 0 : passStringToWasm0(label_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        const ret = wasm.workflowhandle_next_node(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        let v3;
        if (ret[0] !== 0) {
            v3 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v3;
    }
    /**
     * Returns the first authored node source position for host identity-preserving lookup.
     * @param {string} node_id
     * @returns {number | undefined}
     */
    node_index(node_id) {
        const ptr0 = passStringToWasm0(node_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.workflowhandle_node_index(this.__wbg_ptr, ptr0, len0);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * Returns outgoing edge source positions so the host can retain original edge objects.
     * @param {string} node_id
     * @returns {string}
     */
    out_edge_indices(node_id) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ptr0 = passStringToWasm0(node_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.workflowhandle_out_edge_indices(this.__wbg_ptr, ptr0, len0);
            deferred2_0 = ret[0];
            deferred2_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Returns reachable node ids in JavaScript depth-first Set insertion order.
     * @returns {string}
     */
    reachable_node_ids() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.workflowhandle_reachable_node_ids(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Resolves generic JSON through the supplied real expression callback when needed.
     * @param {string} resolvable_json
     * @param {Function} evaluator
     * @returns {string}
     */
    resolve_json(resolvable_json, evaluator) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(resolvable_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.workflowhandle_resolve_json(this.__wbg_ptr, ptr0, len0, evaluator);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Resolves a finite number; blank variable strings retain the legacy rejection path.
     * @param {string} resolvable_json
     * @param {Function} evaluator
     * @returns {number}
     */
    resolve_number(resolvable_json, evaluator) {
        const ptr0 = passStringToWasm0(resolvable_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.workflowhandle_resolve_number(this.__wbg_ptr, ptr0, len0, evaluator);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * Resolves a string with exact template authored/parts behavior and lossless UTF-16 output JSON.
     * @param {string} resolvable_json
     * @param {Function} evaluator
     * @returns {string}
     */
    resolve_string(resolvable_json, evaluator) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(resolvable_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.workflowhandle_resolve_string(this.__wbg_ptr, ptr0, len0, evaluator);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Returns V3 validation errors and preserves first-cycle discovery ordering.
     * @returns {string}
     */
    validate_dag() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.workflowhandle_validate_dag(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) WorkflowHandle.prototype[Symbol.dispose] = WorkflowHandle.prototype.free;

/**
 * Reusable normalized URL trigger rules held in the WASM realm.
 */
export class WorkflowUrlRules {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WorkflowUrlRulesFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_workflowurlrules_free(ptr, 0);
    }
    /**
     * Matches a raw URL using browser URL parsing and the retained compiled rules.
     * @param {string} raw_url_json
     * @returns {boolean}
     */
    matches(raw_url_json) {
        const ptr0 = passStringToWasm0(raw_url_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.workflowurlrules_matches(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Compiles authored rules once using browser String normalization semantics.
     * @param {string} rules_json
     */
    constructor(rules_json) {
        const ptr0 = passStringToWasm0(rules_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.workflowurlrules_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        WorkflowUrlRulesFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) WorkflowUrlRules.prototype[Symbol.dispose] = WorkflowUrlRules.prototype.free;

/**
 * Classifies a host-observed tab-operation message without serializing opaque error objects.
 * @param {string} message_json
 * @param {string} tab_id_display_json
 * @returns {string}
 */
export function browser_metadata_classify_tab_error(message_json, tab_id_display_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(message_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(tab_id_display_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.browser_metadata_classify_tab_error(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Selects host-owned tab indexes for close-tab filters using native JavaScript matching intrinsics.
 * @param {string} filters_json
 * @param {string} candidates_json
 * @param {string} except_tab_ids_json
 * @param {number} now_ms
 * @returns {string}
 */
export function browser_metadata_close_tab_match_indexes(filters_json, candidates_json, except_tab_ids_json, now_ms) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(filters_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(candidates_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(except_tab_ids_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.browser_metadata_close_tab_match_indexes(ptr0, len0, ptr1, len1, ptr2, len2, now_ms);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Returns matching marker indexes without moving IndexedDB-owned marker objects across WASM.
 * @param {string} markers_json
 * @param {string} current_json
 * @returns {string}
 */
export function browser_metadata_matching_marker_indexes(markers_json, current_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(markers_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(current_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.browser_metadata_matching_marker_indexes(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Expands a navigation URL into existing Chrome query patterns using host-observed URL facts.
 * @param {string} input_json
 * @param {string} parsed_json
 * @returns {string}
 */
export function browser_metadata_navigation_url_patterns(input_json, parsed_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(parsed_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.browser_metadata_navigation_url_patterns(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Normalizes stored marker URL fields around a host-native `URL` parse result.
 * @param {string} raw_json
 * @param {string} parsed_json
 * @returns {string}
 */
export function browser_metadata_normalize_marker_url(raw_json, parsed_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(raw_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(parsed_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.browser_metadata_normalize_marker_url(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Returns source indexes stably sorted by window id then tab id.
 * @param {string} rows_json
 * @returns {string}
 */
export function browser_metadata_owned_tab_order(rows_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(rows_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.browser_metadata_owned_tab_order(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Selects the best existing navigation candidate index without moving Chrome tab objects.
 * @param {string} target_json
 * @param {string} candidates_json
 * @returns {string}
 */
export function browser_metadata_pick_navigation_candidate(target_json, candidates_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(target_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(candidates_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.browser_metadata_pick_navigation_candidate(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Plans pacing tool validation while retaining JavaScript non-finite-number distinctions.
 * @param {string} profile_json
 * @param {string} min_gap_ms_json
 * @param {string} jitter_ms_json
 * @returns {string}
 */
export function browser_metadata_plan_pacing_input(profile_json, min_gap_ms_json, jitter_ms_json) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(profile_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(min_gap_ms_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(jitter_ms_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.browser_metadata_plan_pacing_input(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Resolves the resource registry's request client key without claiming any browser tab.
 * @param {string} client_id_json
 * @returns {string}
 */
export function browser_metadata_registry_client_key(client_id_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(client_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.browser_metadata_registry_client_key(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Selects host registry entries that a client-release event must evict.
 * @param {string} entries_json
 * @param {string} client_id_json
 * @returns {string}
 */
export function browser_metadata_registry_forget_client_indexes(entries_json, client_id_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(entries_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(client_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.browser_metadata_registry_forget_client_indexes(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Selects host registry entries that a tab-close event must evict.
 * @param {string} entries_json
 * @param {bigint} tab_id
 * @returns {string}
 */
export function browser_metadata_registry_forget_tab_indexes(entries_json, tab_id) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(entries_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.browser_metadata_registry_forget_tab_indexes(ptr0, len0, tab_id);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Returns Rust-owned default configuration while the host retains random id generation.
 * @param {string} node_type
 * @param {string} branch_id
 * @returns {string}
 */
export function builder_default_config(node_type, branch_id) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(node_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(branch_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.builder_default_config(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Extracts candidate flow values from a parsed import payload.
 * @param {string} value_json
 * @returns {string}
 */
export function builder_extract_flow_candidates(value_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.builder_extract_flow_candidates(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Detects a JSON-shaped legacy V2 flow before the caller selects a conversion path.
 * @param {string} value_json
 * @returns {boolean}
 */
export function builder_is_flow_v2(value_json) {
    const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.builder_is_flow_v2(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * Detects a JSON-shaped V3 flow before the caller selects a conversion path.
 * @param {string} value_json
 * @returns {boolean}
 */
export function builder_is_flow_v3(value_json) {
    const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.builder_is_flow_v3(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * Lists fixed model metadata in legacy registry insertion order.
 * @returns {string}
 */
export function builder_list_models() {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.builder_list_models();
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Returns a model metadata object for the retained third-party inference host.
 * @param {string} preset
 * @returns {string}
 */
export function builder_model_info(preset) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(preset, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.builder_model_info(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Tests model identity changes before retained Chrome/offscreen effects begin.
 * @param {string | null | undefined} current_preset
 * @param {string | null | undefined} current_version
 * @param {number | null | undefined} current_dimension
 * @param {string} requested_preset
 * @param {string} requested_version
 * @param {number | null} [requested_dimension]
 * @returns {boolean}
 */
export function builder_needs_model_switch(current_preset, current_version, current_dimension, requested_preset, requested_version, requested_dimension) {
    var ptr0 = isLikeNone(current_preset) ? 0 : passStringToWasm0(current_preset, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len0 = WASM_VECTOR_LEN;
    var ptr1 = isLikeNone(current_version) ? 0 : passStringToWasm0(current_version, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(requested_preset, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(requested_version, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.builder_needs_model_switch(ptr0, len0, ptr1, len1, !isLikeNone(current_dimension), isLikeNone(current_dimension) ? 0 : current_dimension, ptr2, len2, ptr3, len3, !isLikeNone(requested_dimension), isLikeNone(requested_dimension) ? 0 : requested_dimension);
    return ret !== 0;
}

/**
 * Returns the ordered result indexes after Rust-owned score and provider-priority ranking.
 * @param {string} ranks_json
 * @returns {string}
 */
export function builder_quick_panel_rank_order(ranks_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(ranks_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.builder_quick_panel_rank_order(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Selects the existing device scenario recommendation.
 * @param {number} device_memory
 * @param {string} network_speed
 * @param {boolean} prioritize_speed
 * @returns {string}
 */
export function builder_recommend_model_for_device(device_memory, network_speed, prioritize_speed) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(network_speed, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.builder_recommend_model_for_device(device_memory, ptr0, len0, prioritize_speed);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Selects the existing language scenario recommendation.
 * @param {string} scenario
 * @returns {string}
 */
export function builder_recommend_model_for_language(scenario) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(scenario, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.builder_recommend_model_for_language(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Applies portable screenshot-to-viewport coordinate scaling.
 * @param {number} x
 * @param {number} y
 * @param {number} screenshot_width
 * @param {number} screenshot_height
 * @param {number} viewport_width
 * @param {number} viewport_height
 * @returns {any}
 */
export function builder_scale_screenshot_coordinates(x, y, screenshot_width, screenshot_height, viewport_width, viewport_height) {
    const ret = wasm.builder_scale_screenshot_coordinates(x, y, screenshot_width, screenshot_height, viewport_width, viewport_height);
    return ret;
}

/**
 * Decides screenshot metadata expiry while the host retains the original opaque context object.
 * @param {number} timestamp
 * @param {number} now
 * @returns {boolean}
 */
export function builder_screenshot_context_expired(timestamp, now) {
    const ret = wasm.builder_screenshot_context_expired(timestamp, now);
    return ret !== 0;
}

/**
 * Validates a serialized declarative builder node configuration.
 * @param {string} node_type
 * @param {string} config_json
 * @returns {string}
 */
export function builder_validate_node(node_type, config_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(node_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(config_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.builder_validate_node(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Resolves all longhand winners in one metadata batch, retaining JS candidate identities.
 * @param {any} candidates
 * @returns {any}
 */
export function editor_cascade_overrides(candidates) {
    const ret = wasm.editor_cascade_overrides(candidates);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Compares host-collected CSS cascade metadata.
 * @param {any} left
 * @param {any} right
 * @returns {number}
 */
export function editor_compare_cascade(left, right) {
    const ret = wasm.editor_compare_cascade(left, right);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

/**
 * Compares pre-read computed CSS maps with the editor's numeric tolerance policy.
 * @param {string} input_json
 * @returns {string}
 */
export function editor_compare_computed(input_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_compare_computed(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Compares source order without serializing JavaScript numeric values through JSON.
 * @param {any} left
 * @param {any} right
 * @returns {number}
 */
export function editor_compare_source_order(left, right) {
    const ret = wasm.editor_compare_source_order(left, right);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

/**
 * Compares two CSS specificity tuples.
 * @param {string} left_json
 * @param {string} right_json
 * @returns {bigint}
 */
export function editor_compare_specificity(left_json, right_json) {
    const ptr0 = passStringToWasm0(left_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(right_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.editor_compare_specificity(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

/**
 * Computes a complete stateless snap operation for the compatibility facade.
 * @param {any} input
 * @returns {any}
 */
export function editor_compute_snap(input) {
    const ret = wasm.editor_compute_snap(input);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Computes a complete stateless distance-label operation for the compatibility facade.
 * @param {any} input
 * @returns {any}
 */
export function editor_compute_snap_distance_labels(input) {
    const ret = wasm.editor_compute_snap_distance_labels(input);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Computes the complete editor specificity grammar without replacing JavaScript code units.
 * @param {string} value_json
 * @returns {string}
 */
export function editor_compute_specificity(value_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_compute_specificity(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Expands one normalized shorthand using the editor's cascade metadata.
 * @param {string} value_json
 * @returns {string}
 */
export function editor_expand_css_shorthand(value_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_expand_css_shorthand(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Extracts custom-property names from arbitrary CSS text.
 * @param {string} value_json
 * @returns {string}
 */
export function editor_extract_css_var_names(value_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_extract_css_var_names(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Finds a named CSS function while preserving quoted and escaped arguments.
 * @param {string} value_json
 * @param {string} name_json
 * @returns {string}
 */
export function editor_find_css_function(value_json, name_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(name_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.editor_find_css_function(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Formats a custom-property reference without crossing into CSSOM.
 * @param {string} name_json
 * @param {string} fallback_json
 * @returns {string}
 */
export function editor_format_css_var(name_json, fallback_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(name_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(fallback_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.editor_format_css_var(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Associates inline and computed gradient stops by nearest position.
 * @param {string} inline_json
 * @param {string} computed_json
 * @returns {string}
 */
export function editor_gradient_placeholder_mapping(inline_json, computed_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(inline_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(computed_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.editor_gradient_placeholder_mapping(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Interpolates two gradient-stop colors.
 * @param {string} left_json
 * @param {string} right_json
 * @param {number} t
 * @returns {string}
 */
export function editor_interpolate_rgba(left_json, right_json, t) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(left_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(right_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.editor_interpolate_rgba(ptr0, len0, ptr1, len1, t);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Tests the editor's curated CSS inheritance metadata.
 * @param {string} value_json
 * @returns {boolean}
 */
export function editor_is_inheritable_property(value_json) {
    const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.editor_is_inheritable_property(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * Selects the first highest-specificity member of a host-matched selector collection.
 * @param {string} selectors_json
 * @returns {string}
 */
export function editor_matched_specificity(selectors_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(selectors_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_matched_specificity(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Normalizes one web-editor apply-batch payload while retaining its `elements` array identity.
 * @param {any} raw
 * @returns {any}
 */
export function editor_normalize_apply_batch_payload(raw) {
    const ret = wasm.editor_normalize_apply_batch_payload(raw);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Normalizes one web-editor apply payload without serializing opaque JavaScript values.
 * @param {any} raw
 * @returns {any}
 */
export function editor_normalize_apply_payload(raw) {
    const ret = wasm.editor_normalize_apply_payload(raw);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Normalizes one browser-read property name for inheritance and shorthand lookup.
 * @param {string} value_json
 * @returns {string}
 */
export function editor_normalize_css_property(value_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_normalize_css_property(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Normalizes one browser-read CSS value using the same policy as computed-map comparison.
 * @param {string} value_json
 * @returns {string}
 */
export function editor_normalize_css_value(value_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_normalize_css_value(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Normalizes one parsed gradient-stop collection.
 * @param {string} stops_json
 * @returns {string}
 */
export function editor_normalize_gradient_stops(stops_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(stops_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_normalize_gradient_stops(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Normalizes one effects-control length.
 * @param {string} value_json
 * @returns {string}
 */
export function editor_normalize_length(value_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_normalize_length(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Coerces a primitive JavaScript string, retaining the historical empty-string fallback.
 * @param {any} value
 * @returns {any}
 */
export function editor_normalize_string(value) {
    const ret = wasm.editor_normalize_string(value);
    return ret;
}

/**
 * Normalizes display text using the same policy as editor comparisons.
 * @param {string} value_json
 * @returns {string}
 */
export function editor_normalize_text(value_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_normalize_text(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Parses the first box-shadow expression without browser color resolution.
 * @param {string} value_json
 * @returns {string}
 */
export function editor_parse_box_shadow(value_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_parse_box_shadow(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Parses one standalone custom-property expression.
 * @param {string} value_json
 * @returns {string}
 */
export function editor_parse_css_var(value_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_parse_css_var(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Parses a hexadecimal gradient-stop color.
 * @param {string} value_json
 * @returns {string}
 */
export function editor_parse_hex_color(value_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_parse_hex_color(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Parses an RGB or RGBA gradient-stop color.
 * @param {string} value_json
 * @returns {string}
 */
export function editor_parse_rgb_color(value_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_parse_rgb_color(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Formats an RGBA value for authored CSS.
 * @param {string} color_json
 * @returns {string}
 */
export function editor_rgba_to_css(color_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(color_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_rgba_to_css(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Scores a host-collected HMR candidate fingerprint.
 * @param {string} input_json
 * @returns {number | undefined}
 */
export function editor_score_fingerprint_candidate(input_json) {
    const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.editor_score_fingerprint_candidate(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    return ret[0] === 0 ? undefined : ret[1];
}

/**
 * Splits an authored CSS value at top-level separators.
 * @param {string} value_json
 * @param {string} separator_json
 * @returns {string}
 */
export function editor_split_css_top_level(value_json, separator_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(separator_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.editor_split_css_top_level(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Splits a selector list with the Rust CSS grammar scanner.
 * @param {string} value_json
 * @returns {string}
 */
export function editor_split_selector_list(value_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_split_selector_list(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Tokenizes an authored CSS value at top-level whitespace.
 * @param {string} value_json
 * @returns {string}
 */
export function editor_tokenize_css_top_level(value_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.editor_tokenize_css_top_level(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Selects builder linear-step node positions after Rust filters trigger/default graph structure.
 * @param {string} nodes_json
 * @param {string} edges_json
 * @returns {string}
 */
export function graph_legacy_builder_step_indexes(nodes_json, edges_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(nodes_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(edges_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.graph_legacy_builder_step_indexes(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Selects a trigger's first default successor without serializing host graph resources.
 * @param {string} edges_json
 * @param {string} current_id_json
 * @returns {number | undefined}
 */
export function graph_legacy_default_successor(edges_json, current_id_json) {
    const ptr0 = passStringToWasm0(edges_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(current_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.graph_legacy_default_successor(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] === Number.MAX_SAFE_INTEGER ? undefined : ret[0];
}

/**
 * Selects the one delay property the host must coerce with JavaScript's `Number`.
 * @param {boolean} sleep_is_nullish
 * @param {boolean} ms_is_nullish
 * @returns {string}
 */
export function graph_legacy_delay_source(sleep_is_nullish, ms_is_nullish) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.graph_legacy_delay_source(sleep_is_nullish, ms_is_nullish);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Runs legacy scheduler graph policy over host projections, returning only source indexes.
 * @param {string} nodes_json
 * @param {string} edges_json
 * @returns {string}
 */
export function graph_legacy_execution_plan(nodes_json, edges_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(nodes_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(edges_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.graph_legacy_execution_plan(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Selects flow-store conversion and retained-versus-generated edge behavior.
 * @param {boolean} has_nodes
 * @param {boolean} has_steps
 * @param {string} nodes_json
 * @param {string} edges_json
 * @returns {string}
 */
export function graph_legacy_flow_normalization_plan(has_nodes, has_steps, nodes_json, edges_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(nodes_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(edges_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.graph_legacy_flow_normalization_plan(has_nodes, has_steps, ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Selects an exact legacy branch label without applying default-edge fallback.
 * @param {string} edges_json
 * @param {string} current_id_json
 * @param {string} label_json
 * @returns {number | undefined}
 */
export function graph_legacy_labeled_edge(edges_json, current_id_json, label_json) {
    const ptr0 = passStringToWasm0(edges_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(current_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(label_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.graph_legacy_labeled_edge(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] === Number.MAX_SAFE_INTEGER ? undefined : ret[0];
}

/**
 * Selects a scheduler successor without serializing node or edge host metadata.
 * @param {string} edges_json
 * @param {string} current_id_json
 * @param {string} label_json
 * @returns {number | undefined}
 */
export function graph_legacy_next_edge(edges_json, current_id_json, label_json) {
    const ptr0 = passStringToWasm0(edges_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(current_id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(label_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.graph_legacy_next_edge(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] === Number.MAX_SAFE_INTEGER ? undefined : ret[0];
}

/**
 * Produces one core-owned step patch; the host reattaches only the original configuration object.
 * @param {string} node_json
 * @returns {string}
 */
export function graph_legacy_node_to_step_plan(node_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(node_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.graph_legacy_node_to_step_plan(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Orders legacy node-to-step source positions, preserving no-edge source order in Rust.
 * @param {string} nodes_json
 * @param {string} edges_json
 * @returns {string}
 */
export function graph_legacy_nodes_to_step_indexes(nodes_json, edges_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(nodes_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(edges_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.graph_legacy_nodes_to_step_indexes(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Clamps a single host-coerced legacy delay number through Rust policy.
 * @param {string} number_input_json
 * @returns {string}
 */
export function graph_legacy_normalize_delay(number_input_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(number_input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.graph_legacy_normalize_delay(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Generates sequential legacy DAG edge identifiers from source node projections.
 * @param {string} nodes_json
 * @returns {string}
 */
export function graph_legacy_sequential_edges(nodes_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(nodes_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.graph_legacy_sequential_edges(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Produces default identifiers and types for legacy step-to-node conversion.
 * @param {string} steps_json
 * @returns {string}
 */
export function graph_legacy_steps_to_nodes_plan(steps_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(steps_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.graph_legacy_steps_to_nodes_plan(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Orders an arbitrary legacy edge set with the historical Kahn/cycle-fallback policy.
 * @param {string} nodes_json
 * @param {string} edges_json
 * @returns {string}
 */
export function graph_legacy_topo_order_indexes(nodes_json, edges_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(nodes_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(edges_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.graph_legacy_topo_order_indexes(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Returns source positions of non-dangling edges for legacy flow normalization.
 * @param {string} nodes_json
 * @param {string} edges_json
 * @returns {string}
 */
export function graph_legacy_valid_edge_indexes(nodes_json, edges_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(nodes_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(edges_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.graph_legacy_valid_edge_indexes(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Returns a pure mutation plan, or undefined when the original result must be retained.
 * @param {any} result
 * @param {any} options
 * @returns {any}
 */
export function output_budget_plan(result, options) {
    const ret = wasm.output_budget_plan(result, options);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Makes the Rust-owned public default available to generated build metadata.
 * @returns {number}
 */
export function output_default_budget_bytes() {
    const ret = wasm.output_default_budget_bytes();
    return ret >>> 0;
}

/**
 * Computes ActionRegistry's total attempt count without scheduling retries.
 * @param {number} retries
 * @returns {number}
 */
export function replay_action_max_attempts(retries) {
    const ret = wasm.replay_action_max_attempts(retries);
    return ret;
}

/**
 * Evaluates a legacy condition through the Rust-owned resolver and narrow JavaScript intrinsics.
 * @param {any} condition
 * @param {any} variables
 * @returns {boolean}
 */
export function replay_evaluate_condition(condition, variables) {
    const ret = wasm.replay_evaluate_condition(condition, variables);
    return ret !== 0;
}

/**
 * Returns the execution-mode action sets owned by the Rust policy module.
 * @returns {string}
 */
export function replay_execution_mode_sets() {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.replay_execution_mode_sets();
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Clamps a foreach worker count while retaining JavaScript NaN and infinity values.
 * @param {number} value
 * @returns {number}
 */
export function replay_foreach_concurrency(value) {
    const ret = wasm.replay_foreach_concurrency(value);
    return ret;
}

/**
 * Returns the exact bounded foreach control declaration without executing subflows.
 * @param {string} input_json
 * @param {number} concurrency
 * @returns {string}
 */
export function replay_foreach_plan(input_json, concurrency) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.replay_foreach_plan(ptr0, len0, concurrency);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Selects a branch label after JavaScript evaluates user-authored expressions.
 * @param {string} labels_json
 * @param {string} matching_index_json
 * @param {boolean} has_else
 * @param {string} else_label
 * @returns {string}
 */
export function replay_if_branch_label(labels_json, matching_index_json, has_else, else_label) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(labels_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(matching_index_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(else_label, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.replay_if_branch_label(ptr0, len0, ptr1, len1, has_else, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Constructs the immutable initial recorded-flow fields; the host retains empty arrays by identity.
 * @param {string} authored_meta_json
 * @param {string} generated_id
 * @param {string} timestamp
 * @returns {string}
 */
export function replay_initial_flow_plan(authored_meta_json, generated_id, timestamp) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(authored_meta_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(generated_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(timestamp, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.replay_initial_flow_plan(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Plans sequential DAG mutation for one recorded event without copying its opaque config.
 * @param {string | null | undefined} previous_node_id
 * @param {number} edge_count
 * @param {string} step_id
 * @returns {string}
 */
export function replay_recorded_step_append_plan(previous_node_id, edge_count, step_id) {
    let deferred4_0;
    let deferred4_1;
    try {
        var ptr0 = isLikeNone(previous_node_id) ? 0 : passStringToWasm0(previous_node_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(step_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.replay_recorded_step_append_plan(ptr0, len0, edge_count, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Plans all recording-session upsert/rechain decisions while JavaScript retains config values.
 * @param {string} input_json
 * @returns {string}
 */
export function replay_recording_append_plan(input_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.replay_recording_append_plan(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Rebuilds recording-session cache indexes without crossing opaque node config values.
 * @param {string} nodes_json
 * @param {number} edge_seq
 * @returns {string}
 */
export function replay_recording_cache_plan(nodes_json, edge_seq) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(nodes_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.replay_recording_cache_plan(ptr0, len0, edge_seq);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Selects a recording node type while preserving JavaScript's warning side effect in the host.
 * @param {string} step_type
 * @returns {string}
 */
export function replay_recording_node_type_plan(step_type) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(step_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.replay_recording_node_type_plan(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Plans variable upserts using native SameValueZero key identity, retaining opaque values in JS.
 * @param {Array<any>} existing
 * @param {Array<any>} incoming
 * @returns {any}
 */
export function replay_recording_variable_append_plan(existing, incoming) {
    const ret = wasm.replay_recording_variable_append_plan(existing, incoming);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Resolves one legacy value while retaining raw JavaScript object identity.
 * @param {any} value
 * @param {any} variables
 * @returns {any}
 */
export function replay_resolve_json(value, variables) {
    const ret = wasm.replay_resolve_json(value, variables);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Resolves one finite legacy number with JavaScript trim and Number coercion.
 * @param {any} value
 * @param {any} variables
 * @returns {any}
 */
export function replay_resolve_number(value, variables) {
    const ret = wasm.replay_resolve_number(value, variables);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Resolves a string, returning policy failures and propagating native intrinsic exceptions.
 * @param {any} value
 * @param {any} variables
 * @returns {any}
 */
export function replay_resolve_string(value, variables) {
    const ret = wasm.replay_resolve_string(value, variables);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Computes one effect-free legacy retry delay after the host coerces numeric inputs.
 * @param {number} base
 * @param {string} backoff
 * @param {number} attempt
 * @returns {number}
 */
export function replay_retry_delay_ms(base, backoff, attempt) {
    const ptr0 = passStringToWasm0(backoff, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.replay_retry_delay_ms(base, ptr0, len0, attempt);
    return ret;
}

/**
 * Applies the historical retry exhaustion comparison to host-coerced values.
 * @param {number} attempt
 * @param {number} max
 * @returns {boolean}
 */
export function replay_retry_exhausted(attempt, max) {
    const ret = wasm.replay_retry_exhausted(attempt, max);
    return ret !== 0;
}

/**
 * Tests whether ActionRegistry may retry a result without inspecting its opaque payload.
 * @param {boolean} has_policy
 * @param {number} retries
 * @param {string | null | undefined} error_code
 * @param {string} retry_on_json
 * @returns {boolean}
 */
export function replay_should_retry_action(has_policy, retries, error_code, retry_on_json) {
    var ptr0 = isLikeNone(error_code) ? 0 : passStringToWasm0(error_code, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(retry_on_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.replay_should_retry_action(has_policy, retries, ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * Routes a legacy record/replay step to actions or the legacy executor.
 * @param {string} mode
 * @param {string} step_type
 * @param {string} legacy_only_json
 * @param {string} actions_allowlist_json
 * @returns {boolean}
 */
export function replay_should_use_actions(mode, step_type, legacy_only_json, actions_allowlist_json) {
    const ptr0 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(step_type, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(legacy_only_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passStringToWasm0(actions_allowlist_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.replay_should_use_actions(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * Normalizes a supplied ActionRegistry timeout without creating timers.
 * @param {number} value
 * @returns {number}
 */
export function replay_timeout_ms(value) {
    const ret = wasm.replay_timeout_ms(value);
    return ret;
}

/**
 * Projects V3 policy fields to the V2 handler shape before JavaScript invokes the handler.
 * @param {string} policy_json
 * @returns {string}
 */
export function replay_v2_action_policy(policy_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(policy_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.replay_v2_action_policy(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Produces all ordered V3 variable-patch operations after one V2 action result.
 * @param {string} before_json
 * @param {string} after_json
 * @returns {string}
 */
export function replay_v2_adapter_result_plan(before_json, after_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(before_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(after_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.replay_v2_adapter_result_plan(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Maps a V2 error code to the V3 compatibility code without rebuilding its error envelope.
 * @param {string} code
 * @returns {string}
 */
export function replay_v2_error_code(code) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(code, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.replay_v2_error_code(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Validates an if declaration before host-owned condition evaluation.
 * @param {boolean} has_branches
 * @param {boolean} has_condition
 * @returns {string | undefined}
 */
export function replay_validate_if(has_branches, has_condition) {
    const ret = wasm.replay_validate_if(has_branches, has_condition);
    let v1;
    if (ret[0] !== 0) {
        v1 = getStringFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v1;
}

/**
 * Clamps a while iteration bound while retaining JavaScript NaN and infinity values.
 * @param {number} value
 * @returns {number}
 */
export function replay_while_max_iterations(value) {
    const ret = wasm.replay_while_max_iterations(value);
    return ret;
}

/**
 * Returns the exact bounded while control declaration without evaluating its expression.
 * @param {string} input_json
 * @param {number} max_iterations
 * @returns {string}
 */
export function replay_while_plan(input_json, max_iterations) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.replay_while_plan(ptr0, len0, max_iterations);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Compares two queue rows using V3's priority/FIFO comparator.
 * @param {number} left_priority
 * @param {number} left_created_at
 * @param {number} right_priority
 * @param {number} right_created_at
 * @returns {number}
 */
export function run_policy_compare_queue_items(left_priority, left_created_at, right_priority, right_created_at) {
    const ret = wasm.run_policy_compare_queue_items(left_priority, left_created_at, right_priority, right_created_at);
    return ret;
}

/**
 * Computes the next local-time cron fire using only host Date candidate observations.
 * @param {string} cron
 * @param {number} from_ms
 * @param {Function} local_candidate
 * @returns {number}
 */
export function run_policy_cron_next_local(cron, from_ms, local_candidate) {
    const ptr0 = passStringToWasm0(cron, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.run_policy_cron_next_local(ptr0, len0, from_ms, local_candidate);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

/**
 * Computes the next zoned cron fire using only host Intl DateTimeFormat observations.
 * @param {string} cron
 * @param {string} timezone
 * @param {number} from_ms
 * @param {Function} zoned_parts
 * @returns {number}
 */
export function run_policy_cron_next_zoned(cron, timezone, from_ms, zoned_parts) {
    const ptr0 = passStringToWasm0(cron, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(timezone, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.run_policy_cron_next_zoned(ptr0, len0, ptr1, len1, from_ms, zoned_parts);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

/**
 * Canonicalizes a complete DOM-observer trigger payload batch and asks the host only to observe
 * native `localeCompare` ordering.
 * @param {any} entries
 * @param {Function} locale_compare
 * @param {Function} stringify
 * @param {Function} trim
 * @returns {string}
 */
export function run_policy_dom_trigger_payload(entries, locale_compare, stringify, trim) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.run_policy_dom_trigger_payload(entries, locale_compare, stringify, trim);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Selects an error-routing branch without evaluating plugins or traversing edges.
 * @param {string} policy_json
 * @param {boolean} has_on_error_edge
 * @returns {string}
 */
export function run_policy_error_plan(policy_json, has_on_error_edge) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(policy_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.run_policy_error_plan(ptr0, len0, has_on_error_edge);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Returns whether a host-supplied lease expiration is strictly before the current time.
 * @param {number} expires_at
 * @param {number} now
 * @returns {boolean}
 */
export function run_policy_is_lease_expired(expires_at, now) {
    const ret = wasm.run_policy_is_lease_expired(expires_at, now);
    return ret !== 0;
}

/**
 * Computes a lease expiration from explicit host time and TTL values.
 * @param {number} now
 * @param {number} ttl_ms
 * @returns {number}
 */
export function run_policy_lease_expires_at(now, ttl_ms) {
    const ret = wasm.run_policy_lease_expires_at(now, ttl_ms);
    return ret;
}

/**
 * Plans the V3 node-policy merge while JavaScript retains `undefined` and opaque values.
 * @param {any} _flow_default
 * @param {any} node_policy
 * @returns {string}
 */
export function run_policy_node_policy_merge_plan(_flow_default, node_policy) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.run_policy_node_policy_merge_plan(_flow_default, node_policy);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Normalizes a cron source value through the host's String intrinsics, then validates grammar.
 * @param {any} value
 * @param {Function} normalize
 * @returns {string}
 */
export function run_policy_normalize_cron(value, normalize) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.run_policy_normalize_cron(value, normalize);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Validates and normalizes queue priority and max-attempt inputs without reading browser state.
 * @param {any} priority
 * @param {any} max_attempts
 * @returns {string}
 */
export function run_policy_normalize_enqueue(priority, max_attempts) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.run_policy_normalize_enqueue(priority, max_attempts);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Normalizes a timezone through host String/Intl observations while retaining error policy in Rust.
 * @param {any} value
 * @param {Function} trim
 * @param {Function} is_valid
 * @returns {string | undefined}
 */
export function run_policy_normalize_timezone(value, trim, is_valid) {
    const ret = wasm.run_policy_normalize_timezone(value, trim, is_valid);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    let v1;
    if (ret[0] !== 0) {
        v1 = getStringFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v1;
}

/**
 * Produces stable sort indexes for projected V3 queue rows without serializing JavaScript numbers.
 * @param {any} items
 * @returns {string}
 */
export function run_policy_queue_sort_indexes(items) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.run_policy_queue_sort_indexes(items);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Selects cleanup before orphan-lease recovery from a host-supplied run status.
 * @param {string | null} [status]
 * @returns {string}
 */
export function run_policy_recovery_preclean(status) {
    let deferred2_0;
    let deferred2_1;
    try {
        var ptr0 = isLikeNone(status) ? 0 : passStringToWasm0(status, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len0 = WASM_VECTOR_LEN;
        const ret = wasm.run_policy_recovery_preclean(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Selects the record reconciliation after a host queue lease recovery transition.
 * @param {string} recovered_status
 * @param {string | null} [run_status]
 * @returns {string}
 */
export function run_policy_recovery_reconcile(recovered_status, run_status) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(recovered_status, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        var ptr1 = isLikeNone(run_status) ? 0 : passStringToWasm0(run_status, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len1 = WASM_VECTOR_LEN;
        const ret = wasm.run_policy_recovery_reconcile(ptr0, len0, ptr1, len1);
        deferred3_0 = ret[0];
        deferred3_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Selects screenshot capture without calling Chrome or storing image data.
 * @param {string} policy
 * @param {boolean} failed
 * @returns {boolean}
 */
export function run_policy_should_capture_screenshot(policy, failed) {
    const ptr0 = passStringToWasm0(policy, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.run_policy_should_capture_screenshot(ptr0, len0, failed);
    return ret !== 0;
}

/**
 * Validates the complete five-field cron grammar after host string normalization.
 * @param {string} cron
 */
export function run_policy_validate_cron(cron) {
    const ptr0 = passStringToWasm0(cron, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.run_policy_validate_cron(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Prepares a complete replay target while keeping source/stability handles on original objects.
 * @param {any} target
 * @param {any} scope
 * @returns {any}
 */
export function selector_action_target(target, scope) {
    const ret = wasm.selector_action_target(target, scope);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Returns deterministic ARIA-to-CSS fallback candidates.
 * @param {string} role_json
 * @param {string} name_json
 * @returns {string}
 */
export function selector_aria_to_css(role_json, name_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(role_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(name_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.selector_aria_to_css(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Produces the exact deduplication key for a candidate.
 * @param {string} candidate_json
 * @returns {string}
 */
export function selector_candidate_key(candidate_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(candidate_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.selector_candidate_key(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Preserves JavaScript Number coercion before applying the core's integer-bounds policy.
 * @param {any} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function selector_clamp_action_integer(value, min, max) {
    const ret = wasm.selector_clamp_action_integer(value, min, max);
    return ret;
}

/**
 * Applies the current selector comparator to two candidate JSON values for legacy callers.
 * @param {string} left_json
 * @param {string} right_json
 * @returns {number}
 */
export function selector_compare(left_json, right_json) {
    const ptr0 = passStringToWasm0(left_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(right_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.selector_compare(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

/**
 * Composes a canonical iframe composite selector.
 * @param {string} frame_json
 * @param {string} inner_json
 * @returns {string}
 */
export function selector_compose_composite(frame_json, inner_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(frame_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(inner_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.selector_compose_composite(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Computes a DOM-collected structural fingerprint using JavaScript lower-casing semantics.
 * @param {string} input_json
 * @param {string} options_json
 * @returns {string}
 */
export function selector_compute_fingerprint(input_json, options_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.selector_compute_fingerprint(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Applies a Rust-owned compatibility escape when the host lacks native `CSS.escape`.
 * @param {string} value_json
 * @param {string} mode_json
 * @returns {string}
 */
export function selector_css_escape_fallback(value_json, mode_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(mode_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.selector_css_escape_fallback(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Derives a composite frame selector from a target and its candidate order.
 * @param {string} target_json
 * @returns {string}
 */
export function selector_derive_frame(target_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(target_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.selector_derive_frame(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Derives the text-tag locator hint from a target/candidate index.
 * @param {string} target_json
 * @param {number} candidate_index
 * @returns {string}
 */
export function selector_derive_tag_hint(target_json, candidate_index) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(target_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.selector_derive_tag_hint(ptr0, len0, candidate_index);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Returns eligible class indexes for the web-editor locator DOM adapter.
 * @param {string} classes_json
 * @returns {string}
 */
export function selector_editor_locator_class_indexes(classes_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(classes_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.selector_editor_locator_class_indexes(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Returns a DOM collection plan for the web-editor locator adapter.
 * @param {string} max_candidates_json
 * @param {boolean} anchor_available
 * @returns {string}
 */
export function selector_editor_locator_plan(max_candidates_json, anchor_available) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(max_candidates_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.selector_editor_locator_plan(ptr0, len0, anchor_available);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Selects one complete web-editor locator candidate batch.
 * @param {string} head_candidates_json
 * @param {string} path_candidate_json
 * @param {string} anchor_candidate_json
 * @param {string} max_candidates_json
 * @returns {string}
 */
export function selector_editor_locator_select(head_candidates_json, path_candidate_json, anchor_candidate_json, max_candidates_json) {
    let deferred6_0;
    let deferred6_1;
    try {
        const ptr0 = passStringToWasm0(head_candidates_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(path_candidate_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(anchor_candidate_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passStringToWasm0(max_candidates_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len3 = WASM_VECTOR_LEN;
        const ret = wasm.selector_editor_locator_select(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var ptr5 = ret[0];
        var len5 = ret[1];
        if (ret[3]) {
            ptr5 = 0; len5 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred6_0 = ptr5;
        deferred6_1 = len5;
        return getStringFromWasm0(ptr5, len5);
    } finally {
        wasm.__wbindgen_free(deferred6_0, deferred6_1, 1);
    }
}

/**
 * Applies the default or supplied fingerprint threshold.
 * @param {string} left_json
 * @param {string} right_json
 * @param {string} threshold_json
 * @returns {string}
 */
export function selector_fingerprint_matches(left_json, right_json, threshold_json) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(left_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(right_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(threshold_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.selector_fingerprint_matches(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Computes a fingerprint similarity score using JavaScript lower-casing semantics.
 * @param {string} left_json
 * @param {string} right_json
 * @returns {number}
 */
export function selector_fingerprint_similarity(left_json, right_json) {
    const ptr0 = passStringToWasm0(left_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(right_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.selector_fingerprint_similarity(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

/**
 * Tests composite selector syntax.
 * @param {string} selector_json
 * @returns {boolean}
 */
export function selector_is_composite(selector_json) {
    const ptr0 = passStringToWasm0(selector_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.selector_is_composite(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * Builds the legacy ARIA fallback queries without browser handles or UTF-16 replacement.
 * @param {string} value_json
 * @returns {string}
 */
export function selector_legacy_aria_selectors(value_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.selector_legacy_aria_selectors(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Matches strings using core policy and the browser's native Unicode lowercase intrinsic.
 * @param {string} computed
 * @param {string} target
 * @param {string} mode
 * @returns {boolean}
 */
export function selector_matches_accessible_name(computed, target, mode) {
    const ptr0 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.selector_matches_accessible_name(computed, target, ptr0, len0);
    return ret !== 0;
}

/**
 * Normalizes DOM-observed names without changing the host's synchronous API.
 * @param {string} value
 * @returns {string}
 */
export function selector_normalize_accessible_name(value) {
    const ret = wasm.selector_normalize_accessible_name(value);
    return ret;
}

/**
 * Resolves generator defaults and numeric clamps.
 * @param {string} options_json
 * @returns {string}
 */
export function selector_normalize_options(options_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.selector_normalize_options(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Parses a human-readable ARIA expression.
 * @param {string} input_json
 * @returns {string}
 */
export function selector_parse_aria_expression(input_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.selector_parse_aria_expression(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Parses a fingerprint without dropping empty fields.
 * @param {string} input_json
 * @returns {string}
 */
export function selector_parse_fingerprint(input_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.selector_parse_fingerprint(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Parses a prefixed selector expression.
 * @param {string} input_json
 * @returns {string}
 */
export function selector_parse_prefixed(input_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.selector_parse_prefixed(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Parses a role-selector value.
 * @param {string} input_json
 * @returns {string}
 */
export function selector_parse_role(input_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.selector_parse_role(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Converts a prefixed selector parse result to a candidate patch, or JSON null.
 * @param {string} input_json
 * @returns {string}
 */
export function selector_prefixed_candidate(input_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.selector_prefixed_candidate(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Ranks one raw candidate collection, crossing the WASM boundary only once.
 * @param {string} candidates_json
 * @param {string} options_json
 * @param {string} tag_name_json
 * @returns {string}
 */
export function selector_rank(candidates_json, options_json, tag_name_json) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(candidates_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(options_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(tag_name_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.selector_rank(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Stably reorders a complete persisted candidate collection without deduplicating or truncating.
 * @param {string} candidates_json
 * @returns {string}
 */
export function selector_sort(candidates_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(candidates_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.selector_sort(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Splits a composite selector into frame and inner components, or returns JSON null.
 * @param {string} selector_json
 * @returns {string}
 */
export function selector_split_composite(selector_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(selector_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.selector_split_composite(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Computes one candidate's stability patch.
 * @param {string} candidate_json
 * @returns {string}
 */
export function selector_stability(candidate_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(candidate_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.selector_stability(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Verifies a fingerprint against DOM-collected tag/id values.
 * @param {string} tag_json
 * @param {string} id_json
 * @param {string} fingerprint_json
 * @returns {boolean}
 */
export function selector_verify_fingerprint(tag_json, id_json, fingerprint_json) {
    const ptr0 = passStringToWasm0(tag_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(id_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(fingerprint_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.selector_verify_fingerprint(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * Returns the Rust-owned ANN request count for the retained HNSW host effect.
 * @param {number | null} [requested]
 * @returns {number}
 */
export function semantic_ann_candidate_count(requested) {
    const ret = wasm.semantic_ann_candidate_count(!isLikeNone(requested), isLikeNone(requested) ? 0 : requested);
    return ret;
}

/**
 * Chunks content using JavaScript UTF-16 semantics and returns browser chunk records.
 * @param {string} input_json
 * @returns {string}
 */
export function semantic_chunk_text(input_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.semantic_chunk_text(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Chunks content then applies the page chunk cap before host embedding work.
 * @param {string} input_json
 * @param {number} max_chunks_per_page
 * @returns {string}
 */
export function semantic_chunks_for_indexing(input_json, max_chunks_per_page) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.semantic_chunks_for_indexing(ptr0, len0, max_chunks_per_page);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Computes the synchronous scalar cosine compatibility primitive.
 * @param {Float32Array} left
 * @param {Float32Array} right
 * @returns {number}
 */
export function semantic_cosine_similarity(left, right) {
    const ptr0 = passArrayF32ToWasm0(left, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(right, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.semantic_cosine_similarity(ptr0, len0, ptr1, len1);
    return ret;
}

/**
 * Builds the current host-time document identifier without reading a browser clock.
 * @param {bigint} tab_id
 * @param {number} chunk_index
 * @param {bigint} now_ms
 * @returns {string}
 */
export function semantic_document_id(tab_id, chunk_index, now_ms) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.semantic_document_id(tab_id, chunk_index, now_ms);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Estimates persisted vector storage from host JSON-length observations without reserializing documents.
 * @param {string} document_json_utf16_lengths
 * @param {string} tab_label_counts
 * @param {number} dimension
 * @returns {string}
 */
export function semantic_estimate_storage(document_json_utf16_lengths, tab_label_counts, dimension) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(document_json_utf16_lengths, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(tab_label_counts, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.semantic_estimate_storage(ptr0, len0, ptr1, len1, dimension);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Builds an unchanged index duplicate key from raw URL and title JSON string literals.
 * @param {string} url_json
 * @param {string} title_json
 * @returns {string}
 */
export function semantic_indexed_page_key(url_json, title_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(url_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(title_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.semantic_indexed_page_key(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Applies the existing content-index URL predicate without host normalization.
 * @param {string} url_json
 * @returns {boolean}
 */
export function semantic_is_indexable_content_url(url_json) {
    const ptr0 = passStringToWasm0(url_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.semantic_is_indexable_content_url(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * Applies the existing rebuild-index URL predicate without host normalization.
 * @param {string} url_json
 * @returns {boolean}
 */
export function semantic_is_rebuild_indexable_url(url_json) {
    const ptr0 = passStringToWasm0(url_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.semantic_is_rebuild_indexable_url(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * Validates a contiguous batch supplied as a `Float32Array`.
 * @param {Float32Array} vectors
 * @param {number} dimension
 * @returns {boolean}
 */
export function semantic_is_valid_contiguous_batch(vectors, dimension) {
    const ptr0 = passArrayF32ToWasm0(vectors, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.semantic_is_valid_contiguous_batch(ptr0, len0, dimension);
    return ret !== 0;
}

/**
 * Normalizes an owned contiguous vector while preserving the zero-vector compatibility case.
 * @param {Float32Array} vector
 * @returns {Float32Array}
 */
export function semantic_normalize_vector(vector) {
    const ptr0 = passArrayF32ToWasm0(vector, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.semantic_normalize_vector(ptr0, len0);
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}

/**
 * Reconstructs direct-worker pair scores from one contiguous embedding result batch.
 * @param {string} pairs_json
 * @param {Float32Array} embeddings
 * @param {number} dimension
 * @returns {string}
 */
export function semantic_pair_similarity_scores(pairs_json, embeddings, dimension) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(pairs_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(embeddings, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.semantic_pair_similarity_scores(ptr0, len0, ptr1, len1, dimension);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Plans cache placement and direct-worker versus offscreen inference work.
 * @param {string} texts_json
 * @param {string} cache_hits_json
 * @param {string} mode
 * @returns {string | undefined}
 */
export function semantic_plan_embedding_batch(texts_json, cache_hits_json, mode) {
    const ptr0 = passStringToWasm0(texts_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(cache_hits_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len2 = WASM_VECTOR_LEN;
    const ret = wasm.semantic_plan_embedding_batch(ptr0, len0, ptr1, len1, ptr2, len2);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    let v4;
    if (ret[0] !== 0) {
        v4 = getStringFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v4;
}

/**
 * Plans matrix similarity with one first-occurrence ordered embedding request.
 * @param {string} left_json
 * @param {string} right_json
 * @returns {string}
 */
export function semantic_plan_similarity_matrix(left_json, right_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(left_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(right_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.semantic_plan_similarity_matrix(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Plans pair similarity without duplicating direct-worker deduplication in the host.
 * @param {string} pairs_json
 * @param {string} mode
 * @returns {string}
 */
export function semantic_plan_similarity_pairs(pairs_json, mode) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(pairs_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.semantic_plan_similarity_pairs(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Reconstructs a direct-worker similarity matrix from one contiguous embedding result batch.
 * @param {string} left_json
 * @param {string} right_json
 * @param {Float32Array} embeddings
 * @param {number} dimension
 * @returns {string}
 */
export function semantic_similarity_matrix_scores(left_json, right_json, embeddings, dimension) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(left_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(right_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF32ToWasm0(embeddings, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.semantic_similarity_matrix_scores(ptr0, len0, ptr1, len1, ptr2, len2, dimension);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Validates a document embedding before the host submits it to HNSW.
 * @param {Float32Array} embedding
 * @param {number} dimension
 */
export function semantic_validate_embedding(embedding, dimension) {
    const ptr0 = passArrayF32ToWasm0(embedding, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.semantic_validate_embedding(ptr0, len0, dimension);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Validates a query embedding before the host queries HNSW.
 * @param {Float32Array} embedding
 * @param {number} dimension
 */
export function semantic_validate_query_embedding(embedding, dimension) {
    const ptr0 = passArrayF32ToWasm0(embedding, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.semantic_validate_query_embedding(ptr0, len0, dimension);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Validates a host similarity input while retaining non-string versus empty-string errors.
 * @param {string} value_json
 */
export function semantic_validate_similarity_input(value_json) {
    const ptr0 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.semantic_validate_similarity_input(ptr0, len0);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Builds a `chrome_help` response from the embedded catalog.
 * @param {any} argument
 * @returns {any}
 */
export function shared_catalog_help(argument) {
    const ret = wasm.shared_catalog_help(argument);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Tests a static catalog name without a host-side duplicate index.
 * @param {any} name
 * @returns {boolean}
 */
export function shared_catalog_is_known(name) {
    const ret = wasm.shared_catalog_is_known(name);
    return ret !== 0;
}

/**
 * Returns static catalog names in its contract-defined sorted order.
 * @returns {any}
 */
export function shared_catalog_known_names() {
    const ret = wasm.shared_catalog_known_names();
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Resolves static and dynamic catalog names through the Rust catalog owner.
 * @param {any} name
 * @param {Array<any>} extras
 * @returns {any}
 */
export function shared_catalog_resolve(name, extras) {
    const ret = wasm.shared_catalog_resolve(name, extras);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Searches the embedded catalog with the existing Rust ranking policy.
 * @param {any} query
 * @returns {any}
 */
export function shared_catalog_search(query) {
    const ret = wasm.shared_catalog_search(query);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Suggests a static or dynamic tool name through the Rust catalog owner.
 * @param {any} received
 * @param {Array<any>} extras
 * @returns {any}
 */
export function shared_catalog_suggest(received, extras) {
    const ret = wasm.shared_catalog_suggest(received, extras);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Suggests an enum value without converting an unpaired surrogate through UTF-8.
 * @param {any} received
 * @param {Array<any>} candidates
 * @param {number} max_distance
 * @returns {any}
 */
export function shared_did_you_mean(received, candidates, max_distance) {
    const ret = wasm.shared_did_you_mean(received, candidates, max_distance);
    return ret;
}

/**
 * Identifies an object key whose value must be redacted in non-raw mode.
 * @param {any} key
 * @returns {boolean}
 */
export function shared_is_sensitive_key(key) {
    const ret = wasm.shared_is_sensitive_key(key);
    return ret !== 0;
}

/**
 * Applies the per-string sanitizer length limit while preserving UTF-16 slicing behavior.
 * @param {any} text
 * @param {number} max_length
 * @returns {any}
 */
export function shared_limit_string(text, max_length) {
    const ret = wasm.shared_limit_string(text, max_length);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Returns Rust-owned normalization for sanitizer configuration caps.
 * @param {number} value
 * @param {number} fallback
 * @returns {number}
 */
export function shared_normalize_positive_int(value, fallback) {
    const ret = wasm.shared_normalize_positive_int(value, fallback);
    return ret;
}

/**
 * Applies the ordered text-redaction rules while retaining JavaScript RegExp/String semantics.
 * @param {any} text
 * @param {boolean} raw
 * @returns {any}
 */
export function shared_sanitize_text(text, raw) {
    const ret = wasm.shared_sanitize_text(text, raw);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Filters suggested-next tool names before the host attaches result metadata.
 * @param {Array<any>} hints
 * @param {number} limit
 * @returns {any}
 */
export function shared_suggested_next(hints, limit) {
    const ret = wasm.shared_suggested_next(hints, limit);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Caps formatted output and provides the exact footer fields for the JS envelope.
 * @param {any} text
 * @param {number} max_bytes
 * @returns {any}
 */
export function shared_truncate_output_text(text, max_bytes) {
    const ret = wasm.shared_truncate_output_text(text, max_bytes);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Truncates an INVALID_ARGS received value while retaining JavaScript's JSON/String behavior.
 * @param {any} value
 * @returns {any}
 */
export function shared_truncate_received(value) {
    const ret = wasm.shared_truncate_received(value);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Returns TextEncoder-compatible UTF-8 byte length for a JavaScript string.
 * @param {any} text
 * @returns {number}
 */
export function shared_utf8_byte_length(text) {
    const ret = wasm.shared_utf8_byte_length(text);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

/**
 * Encodes a JavaScript string with TextEncoder-compatible replacement semantics.
 * @param {any} text
 * @returns {string}
 */
export function shared_utf8_to_base64(text) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.shared_utf8_to_base64(text);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * Applies Rust's relative-end plan while preserving original host array resources.
 * @param {Array<any>} values
 * @param {number} max_items
 * @param {string} mode
 * @returns {any}
 */
export function tool_truncate_array(values, max_items, mode) {
    const ptr0 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.tool_truncate_array(values, max_items, ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Keeps JSON.stringify/String host semantics, including cycles and undefined.
 * @param {any} value
 * @param {number} max_bytes
 * @param {string} mode
 * @returns {any}
 */
export function tool_truncate_json(value, max_bytes, mode) {
    const ptr0 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.tool_truncate_json(value, max_bytes, ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Decodes raw strictly: truthy non-booleans retain preview mode.
 * @param {any} raw
 * @returns {string}
 */
export function tool_truncate_mode(raw) {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.tool_truncate_mode(raw);
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Caps lossless JavaScript strings without moving array/image resources into Rust.
 * @param {any} text
 * @param {number} max_bytes
 * @param {string} mode
 * @returns {any}
 */
export function tool_truncate_string(text, max_bytes, mode) {
    const ptr0 = passStringToWasm0(mode, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.tool_truncate_string(text, max_bytes, ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Converts a V2 flow with host-supplied conversion time and browser locale ordering.
 * @param {string} flow_json
 * @param {string} conversion_time_json
 * @returns {string}
 */
export function workflow_convert_v2_to_v3(flow_json, conversion_time_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(flow_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(conversion_time_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.workflow_convert_v2_to_v3(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Converts one V2 trigger, retaining omitted versus explicit weekly `days` arrays.
 * @param {string} trigger_input_json
 * @returns {string}
 */
export function workflow_convert_v2_trigger(trigger_input_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(trigger_input_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.workflow_convert_v2_trigger(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Converts a V3 flow back to the legacy builder's V2 representation.
 * @param {string} flow_json
 * @returns {string}
 */
export function workflow_convert_v3_to_v2(flow_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(flow_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.workflow_convert_v3_to_v2(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Applies legacy assignment paths while preserving source and target JavaScript handles.
 * @param {any} target
 * @param {any} source
 * @param {any} assign
 */
export function workflow_legacy_apply_assign(target, source, assign) {
    const ret = wasm.workflow_legacy_apply_assign(target, source, assign);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Expands legacy `{name}` placeholders without serializing host-owned values.
 * @param {any} value
 * @param {any} scope
 * @returns {any}
 */
export function workflow_legacy_expand_templates_deep(value, scope) {
    const ret = wasm.workflow_legacy_expand_templates_deep(value, scope);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Reads one legacy action-handler path without changing undefined into a serialized value.
 * @param {any} source
 * @param {any} path
 * @returns {any}
 */
export function workflow_legacy_handler_lookup(source, path) {
    const ret = wasm.workflow_legacy_handler_lookup(source, path);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Computes legacy action retry timing from an explicit host random sample.
 * @param {any} policy
 * @param {number} retry_index
 * @param {number} random_sample
 * @returns {number}
 */
export function workflow_legacy_retry_delay(policy, retry_index, random_sample) {
    const ret = wasm.workflow_legacy_retry_delay(policy, retry_index, random_sample);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

/**
 * Matches legacy URL triggers with their raw prefix and substring behavior.
 * @param {any} rules
 * @param {any} raw_url
 * @returns {boolean}
 */
export function workflow_legacy_url_matches(rules, raw_url) {
    const ret = wasm.workflow_legacy_url_matches(rules, raw_url);
    return ret !== 0;
}

/**
 * Computes V3 retry timing from explicit host random data without reading timers or globals.
 * @param {string} policy_json
 * @param {number} attempt
 * @param {number} random_sample
 * @returns {number}
 */
export function workflow_retry_delay(policy_json, attempt, random_sample) {
    const ptr0 = passStringToWasm0(policy_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.workflow_retry_delay(ptr0, len0, attempt, random_sample);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

/**
 * Compiles and matches URL trigger rules through actual browser URL and String intrinsics.
 * @param {string} rules_json
 * @param {string} raw_url_json
 * @returns {boolean}
 */
export function workflow_url_matches(rules_json, raw_url_json) {
    const ptr0 = passStringToWasm0(rules_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(raw_url_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.workflow_url_matches(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_30c8987f7c2ed4e2: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_Number_14af1003b8dd5ead: function(arg0) {
            const ret = Number(arg0);
            return ret;
        },
        __wbg_Number_30763725da19b3cc: function(arg0) {
            const ret = Number(arg0);
            return ret;
        },
        __wbg_Number_c7e89e869c7acfff: function(arg0) {
            const ret = Number(arg0);
            return ret;
        },
        __wbg_Object_b437378b0d6fd42f: function(arg0) {
            const ret = Object(arg0);
            return ret;
        },
        __wbg_String_12a3d0d7933c3f4f: function(arg0) {
            const ret = String(arg0);
            return ret;
        },
        __wbg_String_8564e559799eccda: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_String_aa60b6d263807cd9: function(arg0) {
            const ret = String(arg0);
            return ret;
        },
        __wbg_String_e257194b220865f6: function(arg0) {
            const ret = String(arg0);
            return ret;
        },
        __wbg___wbindgen_bigint_get_as_i64_a2383202b9353e4c: function(arg0, arg1) {
            const v = arg1;
            const ret = typeof(v) === 'bigint' ? v : undefined;
            getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_boolean_get_5b446f51afd21013: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_4687d8d8c2017d52: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_in_92f62ee1427d9e49: function(arg0, arg1) {
            const ret = arg0 in arg1;
            return ret;
        },
        __wbg___wbindgen_is_bigint_b123553bed3bb382: function(arg0) {
            const ret = typeof(arg0) === 'bigint';
            return ret;
        },
        __wbg___wbindgen_is_falsy_16bd49b68658263e: function(arg0) {
            const ret = !arg0;
            return ret;
        },
        __wbg___wbindgen_is_function_1f9d30630b8b1d3d: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_null_e343b7d08827ba72: function(arg0) {
            const ret = arg0 === null;
            return ret;
        },
        __wbg___wbindgen_is_object_3c45d4f2dde4e749: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_90b56bc79aad6f6c: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_8865fb403f8fe9d8: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_jsval_eq_02babf21faa37971: function(arg0, arg1) {
            const ret = arg0 === arg1;
            return ret;
        },
        __wbg___wbindgen_jsval_loose_eq_677f21e468d6b461: function(arg0, arg1) {
            const ret = arg0 == arg1;
            return ret;
        },
        __wbg___wbindgen_number_get_2e0e7dee9f701a71: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_0380ccaa2f57f0d9: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_01721c8c75200a10: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5) {
            const ret = arg0.call(arg1, arg2, arg3, arg4, arg5);
            return ret;
        }, arguments); },
        __wbg_call_1875a20c43a36133: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.call(arg1, arg2, arg3);
            return ret;
        }, arguments); },
        __wbg_call_187d372bd5fdd4aa: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = arg0.call(arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_call_6137034ef55c9d0f: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_concat_43b71fd31b6f5e13: function(arg0, arg1) {
            const ret = arg0.concat(arg1);
            return ret;
        },
        __wbg_construct_2cc135b78387ed16: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.construct(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_done_b41a1d26cdb37fb6: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_encodeURIComponent_0c9d3ee081145a22: function() { return handleError(function (arg0) {
            const ret = encodeURIComponent(arg0);
            return ret;
        }, arguments); },
        __wbg_encodeURIComponent_5808a64d2aa0075f: function(arg0) {
            const ret = encodeURIComponent(arg0);
            return ret;
        },
        __wbg_endsWith_36e30c0a2cfa5feb: function(arg0, arg1) {
            const ret = arg0.endsWith(arg1);
            return ret;
        },
        __wbg_entries_fb6397112b1de25f: function(arg0) {
            const ret = Object.entries(arg0);
            return ret;
        },
        __wbg_from_296ca31f8d0f1c52: function(arg0) {
            const ret = Array.from(arg0);
            return ret;
        },
        __wbg_getPrototypeOf_4e7d85b5bf38d546: function() { return handleError(function (arg0) {
            const ret = Reflect.getPrototypeOf(arg0);
            return ret;
        }, arguments); },
        __wbg_get_31af05bd4842a84f: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_464ae6d03ecb8ac7: function(arg0, arg1) {
            const ret = arg0.get(arg1);
            return ret;
        },
        __wbg_get_658f6698067d9515: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_6c896e0571ddae51: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_unchecked_288889d017702237: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_with_ref_key_6412cf3094599694: function(arg0, arg1) {
            const ret = arg0[arg1];
            return ret;
        },
        __wbg_has_5d6706e5209576c1: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.has(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_hostname_b26b451834eae033: function(arg0) {
            const ret = arg0.hostname;
            return ret;
        },
        __wbg_includes_804ef8eae7140efd: function(arg0, arg1) {
            const ret = arg0.includes(arg1);
            return ret;
        },
        __wbg_instanceof_ArrayBuffer_a99f175873e5d9b8: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Error_80a725f81f2e102d: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Error;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Map_b2611749102d7ba3: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Map;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_828cef2aaacafc31: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_e15a2ff68ffdbef2: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_isSafeInteger_717808ad6a54bd9e: function(arg0) {
            const ret = Number.isSafeInteger(arg0);
            return ret;
        },
        __wbg_isWellFormed_ee6ef25c13723a2b: function(arg0) {
            const ret = arg0.isWellFormed();
            return ret;
        },
        __wbg_iterator_e3c31c892080e444: function() {
            const ret = Symbol.iterator;
            return ret;
        },
        __wbg_keys_440be172f17c0265: function(arg0) {
            const ret = Object.keys(arg0);
            return ret;
        },
        __wbg_length_78dac82682e59660: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_7f3c00c40364105e: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_d4bdea10311bd9cf: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_localeCompare_29229b1617d91f60: function(arg0, arg1) {
            const ret = arg0.localeCompare(arg1);
            return ret;
        },
        __wbg_log_a70cb43d68a03a1c: function(arg0) {
            const ret = Math.log(arg0);
            return ret;
        },
        __wbg_message_5f8387f0c32b90a7: function(arg0) {
            const ret = arg0.message;
            return ret;
        },
        __wbg_new_1dbf7428bba60a42: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
        },
        __wbg_new_28744009d011f847: function() {
            const ret = new Map();
            return ret;
        },
        __wbg_new_2bdcdfcebdfc34d2: function(arg0, arg1) {
            const ret = new TypeError(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_2f0c455872a7873c: function(arg0, arg1, arg2, arg3) {
            const ret = new RegExp(getStringFromWasm0(arg0, arg1), getStringFromWasm0(arg2, arg3));
            return ret;
        },
        __wbg_new_343a093a3c2ffb4e: function(arg0, arg1) {
            const ret = new Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_617a8cdb8bb1130e: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_962c802196464456: function() { return handleError(function (arg0) {
            const ret = new URL(arg0);
            return ret;
        }, arguments); },
        __wbg_new_ee2291f50781bf1d: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_regexp_081d8932147b96af: function() { return handleError(function (arg0) {
            const ret = new RegExp(arg0);
            return ret;
        }, arguments); },
        __wbg_new_with_length_469fcc27bd71672e: function(arg0) {
            const ret = new Array(arg0 >>> 0);
            return ret;
        },
        __wbg_next_33784799010f1bbe: function(arg0) {
            const ret = arg0.next;
            return ret;
        },
        __wbg_next_f4aac29c42af995c: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_parse_0fc53dead14b3b42: function() { return handleError(function (arg0, arg1) {
            const ret = JSON.parse(getStringFromWasm0(arg0, arg1));
            return ret;
        }, arguments); },
        __wbg_pathname_bfe5e17f5aad2133: function(arg0) {
            const ret = arg0.pathname;
            return ret;
        },
        __wbg_prototypesetcall_bc27214492979395: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_push_2baf45db356cf468: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_replace_89a2bb260816315a: function(arg0, arg1, arg2, arg3) {
            const ret = arg0.replace(arg1, getStringFromWasm0(arg2, arg3));
            return ret;
        },
        __wbg_search_9cf5002ecfca6094: function(arg0, arg1) {
            const ret = arg0.search(arg1);
            return ret;
        },
        __wbg_set_145a351398b48c65: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_6ae97e73113c4f0b: function(arg0, arg1, arg2) {
            const ret = arg0.set(arg1, arg2);
            return ret;
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_bea140a88be9b277: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_slice_d5250586a8506ad6: function(arg0, arg1, arg2) {
            const ret = arg0.slice(arg1 >>> 0, arg2 >>> 0);
            return ret;
        },
        __wbg_split_8b3d36efb331dc67: function(arg0, arg1, arg2) {
            const ret = arg0.split(getStringFromWasm0(arg1, arg2));
            return ret;
        },
        __wbg_startsWith_d57fd39368177fd7: function(arg0, arg1) {
            const ret = arg0.startsWith(arg1);
            return ret;
        },
        __wbg_static_accessor_GLOBAL_266715b9d96ba635: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_10fb7dc1ae063179: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_SELF_0b583911f537483a: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_static_accessor_WINDOW_d7f903d1508cbdc4: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_stringify_52ff602c1cc4fbb6: function() { return handleError(function (arg0) {
            const ret = JSON.stringify(arg0);
            return ret;
        }, arguments); },
        __wbg_stringify_843f2046a50880a8: function() { return handleError(function (arg0) {
            const ret = JSON.stringify(arg0);
            return ret;
        }, arguments); },
        __wbg_test_e1f58f4a7ea5136d: function(arg0, arg1) {
            const ret = arg0.test(arg1);
            return ret;
        },
        __wbg_toLowerCase_0c2f7b442b8823dc: function(arg0) {
            const ret = arg0.toLowerCase();
            return ret;
        },
        __wbg_toLowerCase_f66196e2ef2d8379: function(arg0) {
            const ret = arg0.toLowerCase();
            return ret;
        },
        __wbg_trim_264288444af987fa: function(arg0) {
            const ret = arg0.trim();
            return ret;
        },
        __wbg_trim_2e2f044827c94028: function(arg0) {
            const ret = arg0.trim();
            return ret;
        },
        __wbg_trim_3102e7ad7e54de02: function(arg0) {
            const ret = arg0.trim();
            return ret;
        },
        __wbg_valueOf_cb354cbca685cee8: function(arg0) {
            const ret = arg0.valueOf();
            return ret;
        },
        __wbg_value_f3c585ee8f5ba40c: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
        __wbindgen_generic_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_generic_0000000000000002: function(arg0) {
            // Cast intrinsic for `I64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_generic_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000004: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./humanchrome_wasm_bg.js": import0,
    };
}

const RustBrowserStateFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rustbrowserstate_free(ptr, 1));
const RustEditorSnapStateFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rusteditorsnapstate_free(ptr, 1));
const RustEmbeddingCacheFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rustembeddingcache_free(ptr, 1));
const RustRunBreakpointsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rustrunbreakpoints_free(ptr, 1));
const RustTriggerAdmissionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_rusttriggeradmission_free(ptr, 1));
const SemanticIndexFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_semanticindex_free(ptr, 1));
const WorkflowHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_workflowhandle_free(ptr, 1));
const WorkflowUrlRulesFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_workflowurlrules_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }


    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
