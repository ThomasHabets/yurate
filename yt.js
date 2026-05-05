/*
 *    Copyright 2021 Google LLC
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *
 *        https://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */
// Quota check:
// https://console.cloud.google.com/admin/quotas/details;servicem=youtube.googleapis.com;metricm=youtube.googleapis.com%2Fdefault;limitIdm=1%2Fd%2F%7Bproject%7D?project=XXXXXX
//
// Quota costs:
// https://developers.google.com/youtube/v3/determine_quota_cost
//
// Quota use (limit 10k):
// Loading WL: playlist list (cost 1 per page)
// Loading subs: <subscription list (cost 1)> + <subs>*<playlist list (cost 1)>
// Add or remove from WL: 50


// TODO before announce:
// * automatically find and create watch later page

// TODO: make client ID and API key settable, and store in localStorage.
const state_file_specs = [
    {
        name: "state.json.gzip",
        mime_type: "application/gzip",
        compression: "gzip",
    },
    {
        name: "state.json",
        mime_type: "application/json",
        compression: null,
    },
];
const preferred_state_file_spec = state_file_specs[0];
var state_file = null;
var unsaved_changes = false;
const app_data_folder = "appDataFolder";
const maxSubscriptions = 50;
const maxWatchLaterVideos = 50;
const maxSubscriptionVideos = 50;

function set_watch_later()
{
    state.watch_later = document.getElementById("input-watch-later").value;
    log(`Watch later changed to ${state.watch_later}`);
}

function make_empty_state()
{
    return {
        "skip": new Map(), // Map of video IDs that we don't care about, to when they were marked such.
        "videos": new Map(), // Map of video ID to some metadata, for when they get marked private.
        "chan2playlist": new Map(), // Map from channel ID to playlist ID.
        "watch_later": "", // Playlist ID of your watch-later.
    };
}

// Replace any objects with Maps.
function fix_state(st)
{
    let ret = st;
    if (ret === undefined) {
        return make_empty_state();
    }
    if (ret === null) {
        return make_empty_state();
    }
    ["skip", "videos", "chan2playlist"].forEach((e) => {
        if (ret[e].size === undefined) {
            // log("Fixed state entry", e, ret[e]);
            ret[e] = new Map(Object.entries(ret[e]));
        }
    });
    return ret;
}

var state = make_empty_state();

var save_running = false;
function execute_save()
{
    log(`Save callback`);
    if (save_running) {
        log("Save in progress. Waiting for it to complete…");
        setTimeout(execute_save, 1000);
        return;
    }
    saves_in_flight--;
    if (saves_in_flight == 0) {
        log(`Executing save`);
        save_running = true;
        save_state().then((file) => {
            if (saves_in_flight == 0) {
                document.getElementById("unsaved-changes").innerText = "";
                unsaved_changes = false;
            } else {
                log("More saves queued")
            }
            save_running = false;
        }).catch((e) => {
            console.error("Saving:", e);
            save_running = false;
            setTimeout(execute_save, 1000);
        });
    } else {
        log("Skipping save because more changes are queued");
    }
}

var saves_in_flight = 0;
function trigger_save()
{
    unsaved_changes = true;
    if (saves_in_flight == 0) {
        document.getElementById("unsaved-changes").innerText = "Saving unsaved changes…";
    }
    saves_in_flight++;
    log(`Queueing save. Currently ${saves_in_flight} saves pending.`);
    setTimeout(execute_save, 1000);
}

window.addEventListener("load", (event) => {
    document.getElementById("watch-later-select").onchange = function(ev) {
        state.watch_later = this.value;
        trigger_save();
    };

    // Register button handlers.
    [
        ["btn-login", login],
        ["btn-load-wl", render_watch_later],
        ["btn-load-subs", render_subscriptions],
        ["btn-save", save_state],
        ["btn-skip-all", skip_all],
    ].forEach((e) => {
        document.getElementById(e[0]).onclick = e[1];
    });
    show_page("login");

    // TODO: does this actually work?
    login();
});

function show_page(p)
{
    let ps = document.getElementsByClassName("pages");
    for (let i = 0; i < ps.length; i++) {
        ps[i].style.display = "none";
    }
    document.getElementById(`page-${p}`).style.display="block";
}

function load_playlists()
{
    return gapi.client.youtube.playlists.list({
        "part": [
            "snippet"
        ],
        "mine": true
    }).then(function(response) {
        debug("Playlist.list response", response);
        let s = document.getElementById("watch-later-select");
        if (response.result.items.length > 0) {
            s.innerHTML = "";
        }
        let ids = [];
        for (let n in response.result.items) {
            let pl = response.result.items[n];
            ids.push(pl.id);
            let o = document.createElement("option");
            o.value = pl.id;
            o.innerText = pl.snippet.title;
            if (state.watch_later === pl.id) {
                o.selected = true;
            }
            s.appendChild(o);
        }
        s.value = state.watch_later;
        return Promise.resolve(ids);
    }, function(err) { console.error("Loading playlists error", err); });
}

window.onbeforeunload = function() {
    if (unsaved_changes) {
        return "There are unsaved changes. Do you want to navigate away, losing them?";
    }
};

// create state file, and return its ID
function create_state_file(fname, mime_type)
{
    return gapi.client.drive.files.create({
        parents: [app_data_folder],
        name: fname,
        media: {
            mimeType: mime_type,
        },
        fields: "id",
    }).then(function(response){
        log("Drive create response", response);
        return Promise.resolve(response.result.id);
    }, function(err, file) {
        error("Drive create error", err,file);
    });
}

function get_existing_state_file(refresh)
{
    if (refresh === undefined) {
        refresh = false;
    }
    if (!refresh && state_file !== null) {
        return Promise.resolve(state_file);
    }
    return gapi.client.drive.files.list({
        "spaces": [app_data_folder],
        "fields": "nextPageToken, files(id, name, size)",
    }).then(function(response){
        debug("Drive list response (for load)", response);
        let files = response.result.files || [];
        let selected_file = null;
        for (let i = 0; i < state_file_specs.length; i++) {
            let spec = state_file_specs[i];
            for (let n = 0; n < files.length; n++) {
                let f = files[n];
                if (f.name === spec.name) {
                    debug("File", f);
                    selected_file = {
                        id: f.id,
                        name: f.name,
                        size: f.size,
                        spec: spec,
                    };
                    break;
                }
            }
            if (selected_file !== null) {
                break;
            }
        }
        for (let n = 0; n < files.length; n++) {
            let f = files[n];
            debug(`File ${f.name} id ${f.id} ${f.size}`);
        }

        if (selected_file === null) {
            return Promise.resolve(null);
        }
        state_file = selected_file;
        return Promise.resolve(state_file);
    });
}

function get_or_create_preferred_state_file()
{
    if (state_file !== null && state_file.name === preferred_state_file_spec.name) {
        return Promise.resolve(state_file);
    }
    return get_existing_state_file(true).then((existing_file) => {
        if (existing_file !== null && existing_file.name === preferred_state_file_spec.name) {
            return Promise.resolve(existing_file);
        }
        return create_state_file(preferred_state_file_spec.name, preferred_state_file_spec.mime_type).then((file_id) => {
            state_file = {
                id: file_id,
                name: preferred_state_file_spec.name,
                size: 0,
                spec: preferred_state_file_spec,
            };
            return Promise.resolve(state_file);
        });
    });
}

function download_drive_file(file_id) {
    return new Promise((resolve, reject) => {
        var accessToken = gapi.auth.getToken().access_token;
        var xhr = new XMLHttpRequest();
        xhr.responseType = "arraybuffer";
        xhr.open('GET', `https://www.googleapis.com/drive/v2/files/${file_id}?alt=media`);
        xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
        xhr.onload = function() {
            debug("Loaded from Drive", xhr);
            if (xhr.status != 200) {
                reject(`status for ${file_id} not 200: ${xhr.status}`);
                return;
            }
            let buffer = xhr.response;
            if (buffer === null || buffer.byteLength === 0) {
                resolve(new Uint8Array());
                return;
            }
            resolve(new Uint8Array(buffer));
        };
        xhr.onerror = function() {
            reject(null);
        };
        xhr.send();
    });
}

function upload_drive_file(file_id, content, mime_type) {
    return new Promise((resolve, reject) => {
        var accessToken = gapi.auth.getToken().access_token;
        var xhr = new XMLHttpRequest();
        xhr.open('PATCH', `https://www.googleapis.com/upload/drive/v3/files/${file_id}?uploadType=media`);
        xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
        xhr.setRequestHeader('Content-Type', mime_type);
        xhr.onload = function() {
            if (xhr.status < 200 || xhr.status >= 300) {
                reject(`status for ${file_id} not 2xx: ${xhr.status}`);
                return;
            }
            try {
                resolve(JSON.parse(xhr.responseText));
            } catch (err) {
                resolve(xhr.responseText);
            }
        };
        xhr.onerror = function() {
            reject(null);
        };
        xhr.send(content);
    });
}

async function compress_string(s, compression)
{
    if (compression === null) {
        return new TextEncoder().encode(s);
    }
    let stream = new Blob([s], {type: "application/json"}).stream()
        .pipeThrough(new CompressionStream(compression));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decompress_string(buf, compression)
{
    if (buf.byteLength === 0) {
        return "";
    }
    if (compression === null) {
        return new TextDecoder().decode(buf);
    }
    let stream = new Blob([buf], {type: "application/octet-stream"}).stream()
        .pipeThrough(new DecompressionStream(compression));
    return await new Response(stream).text();
}

async function decode_state_file(file, buf)
{
    if (buf.byteLength === 0) {
        return make_empty_state();
    }
    let decoded = await decompress_string(buf, file.spec.compression);
    return state_from_string(decoded);
}
// Load state from Drive, or create empty state.
//
// Returns promise of such state, but it also sets the global variable
// `state` before resolving the promise.
function load_state()
{
    log("Loading settings");

    // Load local storage state first, in case we have that.
    //
    // In case we also have Drive state, then Drive state overrides
    // what we have here.
    let l = state_from_string(localStorage.getItem("state"));
    if (l !== null) {
        //state = fix_state(l);
    }

    let playlistpromise = load_playlists();

    return get_existing_state_file().then((file) => {
        if (file === null) {
            log("No state file found in Drive");
            return Promise.resolve(make_empty_state());
        }
        return download_drive_file(file.id).then((response) => {
            log(`Settings file read from ${file.name}`);
            console.log("State file retrieved", response);
            return decode_state_file(file, response);
        }, function(err) { error("Loading state file", err); });
    }).then((state2) => {
        if (state2 === false || state2 === null || state2 === undefined) {
            state2 = make_empty_state();
        }
        // we need to fix it, because the XHR parsed it as plain
        // JSON where it actually contains maps.
        state2 = fix_state(state2);
        debug("Skip list", state.skip.size, state2.skip.size, state2.skip);
        state.skip = new Map([...state.skip, ...state2.skip]);
        state.videos = new Map([...state.videos, ...state2.videos]);
        state.chan2playlist = new Map([...state.chan2playlist, ...state2.chan2playlist]);
        if (state2.watch_later !== undefined && state2.watch_later != "") {
            state.watch_later = state2.watch_later;
        }
        return playlistpromise.then((ids) => {
            if (state.watch_later === undefined && ids.length > 0) {
                state.watch_later = ids[0];
                trigger_save();
            }
            document.getElementById("watch-later-select").value = state.watch_later;
            return Promise.resolve(state);
        });
    }, function(err) {
        error("Drive load error", err);
    }).catch(function(err) {
        error("Drive load fatal", err);
    });
}

// return a serialized version of the state.
function state_string()
{
    return JSON.stringify(state, (k, value) => {
        if (value instanceof Map) {
            return Object.fromEntries(value);
        }
        return value;
    });
}

// deserialize state and return.
function state_from_string(s)
{
    return fix_state(JSON.parse(s));
}

function format_bytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1000;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const convertedValue = parseFloat((bytes / Math.pow(k, i)).toFixed(2));
    return `${convertedValue} ${sizes[i]}`;
}

// Save state, unconditionally.
function save_state()
{
    let st = window.performance.now();
    let ss = state_string();
    log("Saving state of size", format_bytes(ss.length));
    // Save a backup locally.
    try {
        localStorage.setItem("state", ss);
    } catch (err) {
        debug("Failed to save locally", err);
    }

    // Seems gapi.client.drive.files.create doesn't support actually updating content.
    // https://stackoverflow.com/questions/34905363/create-file-with-google-drive-api-v3-javascript

    // Load from the cloud.
    return get_or_create_preferred_state_file().then(async (file) => {
        let compressed = await compress_string(ss, file.spec.compression);
        log(`Compressed state to ${format_bytes(compressed.byteLength)} using ${file.spec.compression}`);
        let saved_file = await upload_drive_file(file.id, new Blob([compressed], {type: file.spec.mime_type}), file.spec.mime_type);
        let et = window.performance.now();
        log(`Settings saved in ${et - st} ms`, saved_file);
        return Promise.resolve(saved_file);
    }, function(err) {
        error("Save state error", err);
    });
}


function login() {
    log("Starting login");
    show_page("loading");
    authenticate().then(loadClient).then(load_state).then(function(){
        show_page("content");
    }).catch(function(err) {
        error("Logging in", err);
    });
}

function authenticate() {
    log("Authenticating");
    return gapi.auth2.getAuthInstance()
        .signIn({scope: "https://www.googleapis.com/auth/youtube https://www.googleapis.com/auth/drive.appdata"})
        //.signIn({scope: "https://www.googleapis.com/auth/youtube"})
        //.signIn({oauthScopes: ["https://www.googleapis.com/auth/youtube","https://www.googleapis.com/auth/drive.appdata"]})
        .then(function() { log("Sign-in successful");},
              function(err) { error("Error signing in", err);})
        .catch(function(err) { error("catch", err);});
}
function loadClient() {
    log("Loading client");
    gapi.client.setApiKey(api_key);
    return gapi.client.load("https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest").then(function() {
        log("GAPI client loaded for youtube API");
        return gapi.client.load("https://www.googleapis.com/discovery/v1/apis/drive/v3/rest")
    }, function(err) { error("Error loading GAPI client for youtube API", err); }).then(function() {
        log("GAPI client loaded for drive API");
        return gapi.client.load("https://www.googleapis.com/discovery/v1/apis/drive/v3/rest")
    }, function(err) { error("Error loading GAPI client for drive API", err); });
}

function debug(first, ...rest) {
    console.log(first, ...rest);
}
function log(first, ...rest) {
    console.log(first, ...rest);

    let s = first;
    for (let i = 0; i < rest.length; i++) {
        s += " " + JSON.stringify(rest[i]);
    }
    let entry = document.createElement("li");
    entry.innerText = s;
    document.getElementById("log").appendChild(entry);
}

function error(first, ...rest) {
    console.error(first, ...rest);

    let s = first;
    for (let i = 0; i < rest.length; i++) {
        s += " " + JSON.stringify(rest[i]);
    }
    let entry = document.createElement("li");
    entry.className = "error";
    entry.innerText = s;
    document.getElementById("log").appendChild(entry);
}

function render_watch_later() {
    document.getElementById("watch-later-loader").style.display = "block";
    let watch_later = document.getElementById("watch-later");
    watch_later.innerHTML = "";
    gapi.client.youtube.playlistItems.list({
        "part": [
            "contentDetails,snippet"
        ],
        "playlistId": state.watch_later,
        "maxResults": maxWatchLaterVideos,
    }).then(function(response) {
        // Handle the results here (response.result has the parsed body).
        console.log("Playlistitems response", response);
        if (response.result.pageInfo.totalResults > response.result.pageInfo.resultsPerPage) {
            log(`Watch later total ${response.result.pageInfo.totalResults} greater than page size ${maxWatchLaterVideos}`);
        }
        let items = response.result.items;
        for (let i = 0; i < items.length; i++) {
            let video_id = items[i].snippet.resourceId.videoId;
            let playlist_video_id = items[i].id;
            let video_title = items[i].snippet.title;

            // Create elements.
            let img = document.createElement("img");
            let btn = document.createElement("button");
            let li = document.createElement("li");
            let a = document.createElement("a");
            let vtitle = document.createElement("span");
            let thumbnail = items[i].snippet.thumbnails.high;

            // Set attributes.
            if (thumbnail === undefined) {
                // TODO: some broken thumbnail
                let old = state.videos.get(video_id);
                if (old !== undefined) {
                    video_title = `DELETED/PRIVATE: ${old.title}`;
                    img.src = old.thumbnail;
                }
            } else {
                img.src = thumbnail.url;
            }
            a.href = "https://www.youtube.com/watch?v="+video_id;
            vtitle.innerText=video_title;
            btn.innerText = "Delete";
            btn.setAttribute("data-video-id", video_id);
            btn.setAttribute("data-playlist-video-id", playlist_video_id);
            btn.onclick = watch_later_delete_handler;

            // Add elements to DOM.
            a.appendChild(img);
            a.appendChild(vtitle);
            li.appendChild(btn);
            li.appendChild(a);
            watch_later.appendChild(li);
        }
        document.getElementById("watch-later-loader").style.display = "none";
    }, function(err) {
        document.getElementById("watch-later-loader").style.display = "none";
        error("get WL error", err);
    });
}

// Render list of videos from all subscribed channels.
function render_subscriptions()
{
    const tslimit = Date.now()-1000*(86400*30);
    let videos = [];
    let so = document.getElementById("subscription-videos");
    let loading_details = document.getElementById("subscription-loading-details");
    so.innerHTML = "";
    document.getElementById("subscription-loader").style.display = "block";
    get_subscription_playlists().then(function(playlist_ids) {
        console.log("Got all the playlists", playlist_ids);

        let proms = [];
        let playlists_read = 0;
        for (let i = 0; i < playlist_ids.length; i++) {
            // TODO: should this be paginated, or do we only care about the first 50?
            // TODO: use gapi.client.request.newBatch?
            proms.push(gapi.client.youtube.playlistItems.list({
                "part": [
                    "contentDetails,snippet"
                ],
                "playlistId": playlist_ids[i],
                "maxResults": maxSubscriptionVideos,
            }).then(function(response) {
                if (response.result.pageInfo.totalResults > response.result.pageInfo.resultsPerPage) {
                    debug("Subscription uploads greater than page size", response.result.pageInfo.totalResults);
                }
                let items = response.result.items;

                for (let i = 0; i < items.length; i++) {
                    let e = {
                        "id": items[i].snippet.resourceId.videoId,
                        //"playlist_id": items[i].id,
                        "title": items[i].snippet.title,
                        "channel_title": items[i].snippet.channelTitle,
                        "ts": items[i].snippet.publishedAt,
                    };
                    let thumbs = items[i].snippet.thumbnails;
                    if (thumbs.default !== undefined) {
                        e.thumbnail = thumbs.default.url;
                    } else {
                        // Private video, probably.
                        //error("What", items[i], thumbs);
                        let old = state.videos.get(e.id);
                        if (old !== undefined) {
                            e = old;
                        }
                    }
                    if (!state.videos.has(e.id)) {
                        state.videos.set(e.id, e);
                        trigger_save();
                    }
                    if (Date.parse(e.ts) < tslimit) {
                        continue;
                    }
                    if (state.skip.has(e.id)) {
                        continue;
                    }
                    videos.push(e);
                }
                playlists_read++;
                loading_details.innerHTML = `Loaded ${playlists_read} of ${playlist_ids.length} playlists. ${videos.length} videos…`
            }, function(err) { error("get_subscriptions(): playlistItems")}));
        }
        return Promise.all(proms).then(function() {
            videos = [...new Set(videos)]
            videos.sort(function(a,b){
                if (a.ts < b.ts) {
                    return 1;
                }
                if (a.ts > b.ts) {
                    return -1;
                }
                return 0;
            });
            if (videos.length > 0) {
                document.getElementById("btn-skip-all").disabled = false;
            }
            for (let i = 0; i < videos.length; i++) {
                let li = document.createElement("li");
                let a = document.createElement("a");
                let ctitle = document.createElement("span");
                let vtitle = document.createElement("span");
                let img = document.createElement("img");
                let btn_wl = document.createElement("button");
                let btn_skip = document.createElement("button");
                let div_btn = document.createElement("div");

                if (videos[i].thumbnail === undefined) {
                    img.src = "https://cdn.habet.se/favicon.ico";
                } else {
                    img.src = videos[i].thumbnail
                }
                a.href="https://www.youtube.com/watch?v="+videos[i].id;
                vtitle.innerHTML = videos[i].title;
                ctitle.innerHTML = videos[i].channel_title;
                ctitle.className = "channel_title";
                btn_wl.innerHTML = "Watch Later";
                btn_wl.onclick = watch_later_handler;
                btn_wl.setAttribute("data-video-id", videos[i].id)
                btn_skip.innerHTML = "Skip";
                btn_skip.className = "right skip-button";
                btn_skip.onclick = skip_handler;
                btn_skip.setAttribute("data-video-id", videos[i].id)

                a.appendChild(img);
                li.appendChild(ctitle);
                li.appendChild(div_btn);
                li.appendChild(a);
                a.appendChild(vtitle);
                div_btn.appendChild(btn_wl);
                div_btn.appendChild(btn_skip);
                so.appendChild(li);
            }
            document.getElementById("subscription-loader").style.display = "none";
            loading_details.innerText = ""
        }, function(err) {
            error("promise.all failed", err);
            loading_details.innerText = ""
            document.getElementById("subscription-loader").style.display = "none";
        });
    }).catch(function(err) {
        error("Catch", err);
        loading_details.innerText = ""
        document.getElementById("subscription-loader").style.display = "none";
    });
}

function skip_all(ev)
{
    document.querySelectorAll(".skip-button").forEach(btn => btn.click());
    trigger_save();
}

function watch_later_delete_handler(ev)
{
    let playlist_video_id = this.getAttribute("data-playlist-video-id");
    let self = this;
    return gapi.client.youtube.playlistItems.delete({
        "id": playlist_video_id,
    }).then(function(response) {
        // Handle the results here (response.result has the parsed body).
        log("Remove from watch later response", response);
        let child = self.closest("li");
        child.parentElement.removeChild(child);
    }, function(err) { error("Remove from watch later error", err); });
}

    function watch_later_handler(ev)
    {
        return watch_later_handler_button(this);
    }
function watch_later_handler_button(ev)
{
    let video_id = ev.getAttribute("data-video-id");
    console.log("Watch later", ev, video_id);
    let self = ev;
    return gapi.client.youtube.playlistItems.insert({
        "part": [
            "snippet"
        ],
        "resource": {
            "snippet": {
                "playlistId": state.watch_later,
                "position": 0,
                "resourceId": {
                    "kind": "youtube#video",
                    "videoId": video_id,
                }
            }
        }
    }).then(function(response) {
        // Handle the results here (response.result has the parsed body).
        log("Added to watch later response", response);
        // Remove from view, now and in the future.
        state.skip.set(video_id, Date.now())
        trigger_save();
        let child = self.closest("li");
        child.parentElement.removeChild(child);
    }, function(err) { error("Failed to add to watch later", err); });
}

    // Called with the skip button object.
function skip_handler(ev)
    {
        skip_handler_button(this);
}

    function skip_handler_button(ev)
    {
        console.log("Skip", ev);
        state.skip.set(ev.getAttribute("data-video-id"), Date.now())
        trigger_save();
        let child = ev.closest("li");
        child.parentElement.removeChild(child);
    }

// return channels.
function get_subscriptions(channel_ids, next_page)
{
    if (channel_ids === undefined) {
        channel_ids = [];
    }
    return gapi.client.youtube.subscriptions.list({
        "part": [
            "snippet,contentDetails"
        ],
        "maxResults": maxSubscriptions,
        "pageToken": next_page,
        "order": "alphabetical",
        "mine": true
    }).then(function(response) {
        log("Resp my subs", response.result.items.length);
        let items = response.result.items;
        for (let i = 0; i < items.length; i++) {
            let channel_id = items[i].snippet.resourceId.channelId;
            channel_ids.push(channel_id);
        }
        if (response.result.nextPageToken) {
            log("Subscriptions greater than page size, getting next page", response.result.pageInfo.totalResults);
            return get_subscriptions(channel_ids, response.result.nextPageToken);
        }
        if (false) {
            channel_ids=["UCKzuEBKLW3M-1snuqZW5NFA"];
            channel_ids=["UCJ0-OtVpF0wOKEqT2Z1HEtA"];
            channel_ids.push("UCJ0-OtVpF0wOKEqT2Z1HEtA");
        }
        channel_ids.sort();
        //log("Total subs", channel_ids.length, channel_ids);
        channel_ids = [...new Set(channel_ids)]
        //log("... after dedup", channel_ids.length);
        log("Total subscribed channels", channel_ids.length);
        return Promise.resolve(channel_ids);
    });
}

function channels_to_playlists(channel_ids, playlist_ids, next_page)
{
    const page_size = 50;
    let cur_chans = channel_ids.slice(0,page_size);
    let rest_chans = channel_ids.slice(page_size);
    log("Getting playlists", cur_chans.length);
    // TODO: parallelize chunks?
    // This is cached, so not too bad if it's not optimal.
    return gapi.client.youtube.channels.list({
        "part": [
            "snippet,contentDetails"
        ],
        id: [
            cur_chans,
        ],
        "pageToken": next_page,
        "maxResults": page_size,
    }).then(function(response) {
        console.log("Channel list response (for load)", response);
        let items = response.result.items;
        for (let i = 0; i < items.length; i++) {
            let u = items[i].contentDetails.relatedPlaylists.uploads;
            playlist_ids.push(u);
            state.chan2playlist.set(items[i].id, u);
            trigger_save();
        }
        if (items.length != cur_chans.length) {
            error("Did not get a page full", items.length, cur_chans.length, response.result.nextPageToken);
        }
        if (rest_chans.length > 0) {
            log("channels_to_playlists greater than page size, getting next page", response.result.pageInfo.totalResults);
            return channels_to_playlists(rest_chans, playlist_ids, response.result.nextPageToken);
        }
        return [...new Set(playlist_ids)];
    }, function(err) {
        error("get_subscription_playlists error", err);
    });
}

// return a promise for the list of playlist ids.
function get_subscription_playlists()
{
    return get_subscriptions().then(function(channel_ids) {
        let playlist_ids = [];
        let channels_to_fetch = [];
        channel_ids.forEach(function(channel_id) {
            // Check cache.
            let u = state.chan2playlist.get(channel_id);
            if (u !== undefined) {
                playlist_ids.push(u);
                return;
            }
            // Else add to fetch.
            channels_to_fetch.push(channel_id);
        })
        log(`Already cached ${playlist_ids.length} of ${channel_ids.length} playlist mappings`);
        if (channels_to_fetch.length == 0) {
            debug("All playlists cached playlist mappings", playlist_ids);
            return Promise.resolve(playlist_ids);
        }
        return channels_to_playlists([...new Set(channels_to_fetch)], playlist_ids);
    });
}

gapi.load("client:auth2", function() {
    gapi.auth2.init({client_id: client_id});
});

var current_selection = 0;
function hilight_video()
{
    document.querySelectorAll(`#subscription-videos li`).forEach((e) => { e.classList.remove("active-video");});
    if (current_selection > 0) {
        let n = document.querySelector(`#subscription-videos li:nth-child(${current_selection})`);
        n.classList.add("active-video");
    }
}
document.onkeyup = (e) => {
    if (e.key == 'n') {
        current_selection++;
        hilight_video();
    } else if (e.key == 'p') {
        if (current_selection > 1) {
            current_selection--;
        }
        hilight_video();
    } else if (e.key == 's') {
        render_subscriptions();
    } else if (e.key == 'w') {
        //render_watch_later();
    } else if (e.key == 'y') {
        let active = document.querySelector(`#subscription-videos li:nth-child(${current_selection}) button[class*="skip-button"]`);
        watch_later_handler_button(active).then(() => {
            hilight_video();
        });
    } else if (e.key == 'd') {
        let active = document.querySelector(`#subscription-videos li:nth-child(${current_selection}) button[class*="skip-button"]`);
        skip_handler_button(active).then(() => {
            hilight_video();
        });
    } else {
        console.log("Unknown key", e);
    }
};
