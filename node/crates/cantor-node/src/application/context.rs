//! Mutable process resources available while handling one application request.

use std::path::Path;

use cantor_proto::NodeInfo;

use crate::config::NodeConfig;
use crate::library::Library;
use crate::pairing::PairOffer;

pub struct RequestContext<'a> {
    pub config: &'a mut NodeConfig,
    pub config_path: &'a Path,
    pub pair_offer: &'a mut Option<PairOffer>,
    pub node_public_key: &'a str,
    pub node_info: &'a NodeInfo,
    pub library: &'a mut Library,
}
