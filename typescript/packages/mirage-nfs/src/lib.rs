// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

mod bridge;
mod vfs;

use std::time::Duration;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use nfsserve::tcp::{NFSTcp, NFSTcpListener};

use bridge::{call, IdArgs};
use vfs::{Delegate, MirageVFS};

/// A running NFS server. The tokio runtime is napi's own, living
/// inside the extension -- the Node process gains no threads it can
/// see, mirroring the PyO3 crate's stance.
#[napi]
pub struct NfsServerHandle {
    port: u16,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
}

#[napi]
impl NfsServerHandle {
    /// The TCP port actually bound (the requested one, or the OS's
    /// choice when 0 was asked for).
    #[napi]
    pub fn port(&self) -> u16 {
        self.port
    }

    /// Stop serving. The caller flushes buffered writes before this
    /// (NFSManager.close: unmount, flushAll, stop).
    #[napi]
    pub fn stop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

/// Start the NFSv3 server for one delegate. Every argument after the
/// thirteen methods mirrors the PyO3 crate's start().
#[napi]
#[allow(clippy::too_many_arguments)]
pub async fn start(
    lookup: bridge::Method<bridge::NameArgs>,
    getattr: bridge::Method<bridge::IdArgs>,
    set_size: bridge::Method<bridge::SetSizeArgs>,
    read: bridge::Method<bridge::ReadArgs>,
    write: bridge::Method<bridge::WriteArgs>,
    create: bridge::Method<bridge::NameArgs>,
    mkdir: bridge::Method<bridge::NameArgs>,
    remove: bridge::Method<bridge::NameArgs>,
    rename: bridge::Method<bridge::RenameArgs>,
    symlink: bridge::Method<bridge::SymlinkArgs>,
    readlink: bridge::Method<bridge::IdArgs>,
    readdir: bridge::Method<bridge::ReaddirArgs>,
    flush_idle: bridge::Method<bridge::IdArgs>,
    host: String,
    port: u16,
    root_id: f64,
    uid: u32,
    gid: u32,
    idle_seconds: f64,
) -> Result<NfsServerHandle> {
    let flusher = flush_idle.clone();
    let delegate = Delegate {
        lookup,
        getattr,
        set_size,
        read,
        write,
        create,
        mkdir,
        remove,
        rename,
        symlink,
        readlink,
        readdir,
        flush_idle,
    };
    let vfs = MirageVFS::new(delegate, root_id as u64, uid, gid);
    let listener = NFSTcpListener::bind(&format!("{host}:{port}"), vfs)
        .await
        .map_err(|e| Error::from_reason(format!("nfs bind failed: {e}")))?;
    let bound = listener.get_listen_port();
    let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        tokio::select! {
            _ = listener.handle_forever() => {},
            _ = &mut rx => {},
        }
    });
    let period = Duration::from_secs_f64(idle_seconds.max(0.5));
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(period).await;
            let _: std::result::Result<bridge::UnitReply, _> = call(&flusher, IdArgs { id: 0.0 }).await;
        }
    });
    Ok(NfsServerHandle {
        port: bound,
        shutdown: Some(tx),
    })
}
