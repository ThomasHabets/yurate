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
// https://console.cloud.google.com/admin/quotas/details;servicem=youtube.googleapis.com;metricm=youtube.googleapis.com%2Fdefault;limitIdm=1%2Fd%2F%7Bproject%7D?project=XXX
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
// * create state file if it doesn't exist

// TODO: make client ID and API key settable, and store in localStorage.
var client_id = "XXX";
var api_key = "XXX";
const app_data_folder = "appDataFolder";
const maxSubscriptions = 50;
const maxWatchLaterVideos = 50;
const maxSubscriptionVideos = 50;

function set_watch_later()
{
    state.watch_later = document.getElementById("input-watch-later").value;
    log(`Watch later changed to ${state.watch_later}`);
}

var state = {
    "skip": {}, // Map of video IDs that we don't care about, to when they were marked such.
    "videos": {}, // Map of video ID to some metadata, for when they get marked private.
    "chan2playlist": {}, // Map from channel ID to playlist ID.
    "watch_later": "", // Playlist ID of your watch-later.
};

function load_state()
{
    log("Loading settings");

    let l = JSON.parse(localStorage.getItem("state"));
    if (l !== null) {
        state = l;
    }

    // Load from the cloud.
    return gapi.client.drive.files.list({
        "spaces": [app_data_folder],
    }).then(function(response){
        log("Drive list response", response);
        let file = null;
        for (n in response.result.files) {
            file = response.result.files[n];
            log("File", file);
        }
        return gapi.client.drive.files.get({
            "fileId": file.id,
            //"fields": "webContentLink",
            //"fields": "*",
            "alt": "media",
        }).then(function(response) {
            console.log("State file retrieved", response);
            state = response.result;
            if (state.chan2playlist === undefined) { state.chan2playlist = {};}
            if (state.skip === undefined) { state.skip = {};}
            if (state.videos === undefined) { state.videos = {};}
            log("Settings loaded successfully");
        }, function(err) { error("Loading state file", err); });
    }, function(err) {
        error("Drive load error, creating the file", err);
        return gapi.client.drive.files.create({
            parents: [app_data_folder],
            name: "state.json",
            media: {
                mimeType: 'application/json',
            },
            fields: "id",
        }).then(function(response){
            log("Drive create response", response);
        }, function(err, file) {
            error("Drive create error", err,file);
        });
    }).catch(function(err) {
        error("Drive load fatal", err);
    });
}

function save_state()
{
    // Save a backup locally.
    localStorage.setItem("state", JSON.stringify(state));
    // Seems gapi.client.drive.files.create doesn't support actually updating content.
    // https://stackoverflow.com/questions/34905363/create-file-with-google-drive-api-v3-javascript

    // Load from the cloud.
    return gapi.client.drive.files.list({
        "spaces": [app_data_folder],
    }).then(function(response){
        log("Drive list response (for save)", response);
        let file = null;
        for (n in response.result.files) {
            file = response.result.files[n];
            log("File", file);
        }
        let req = gapi.client.request({
            'path': `/upload/drive/v3/files/${file.id}`,
            'method': 'PATCH',
            'params': {'uploadType': 'media'},
            body: JSON.stringify(state),
        });
        // TODO: turn into promise.
        req.execute(function(file) {
            log("Settings saved", file);
        });
    }, function(err) {
        error("Save state error", err);
    });
}


function login() {
    log("Starting login");
    authenticate().then(loadClient).then(load_state).then(function(){
        document.getElementById("btn-load-wl").disabled = false;
        document.getElementById("btn-load-subs").disabled = false;
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

            // Set attributes.
            img.src = items[i].snippet.thumbnails.high.url;
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
                        "ts": items[i].snippet.publishedAt,
                    };
                    let thumbs = items[i].snippet.thumbnails;
                    if (thumbs.default !== undefined) {
                        e.thumbnail = thumbs.default.url;
                    } else {
                        // Private video, probably.
                        //error("What", items[i], thumbs);
                    }
                    if (state.videos[e.id] === undefined) {
                        state.videos[e.id] = e;
                    }
                    if (Date.parse(e.ts) < tslimit) {
                        continue;
                    }
                    if (state.skip[e.id] !== undefined) {
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
                btn_wl.innerHTML = "Watch Later";
                btn_wl.onclick = watch_later_handler;
                btn_wl.setAttribute("data-video-id", videos[i].id)
                btn_skip.innerHTML = "Skip";
                btn_skip.className = "right skip-button";
                btn_skip.onclick = skip_handler;
                btn_skip.setAttribute("data-video-id", videos[i].id)

                a.appendChild(img);
                a.appendChild(vtitle);
                li.appendChild(div_btn);
                li.appendChild(a);
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
    let video_id = this.getAttribute("data-video-id");
    console.log("Watch later", this, video_id);
    let self = this;
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
        state.skip[video_id] = Date.now()
        let child = self.closest("li");
        child.parentElement.removeChild(child);
    }, function(err) { error("Failed to add to watch later", err); });
}

function skip_handler(ev)
{
    console.log("Skip", this);
    state.skip[this.getAttribute("data-video-id")] = Date.now()
    let child = this.closest("li");
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
        console.log("Channel list response", response);
        let items = response.result.items;
        for (let i = 0; i < items.length; i++) {
            let u = items[i].contentDetails.relatedPlaylists.uploads;
            playlist_ids.push(u);
            state.chan2playlist[items[i].id] = u;
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
            let u = state.chan2playlist[channel_id];
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
