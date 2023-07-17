// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {LiquidityThresholdAssetManager} from "@ensuro/core/contracts/LiquidityThresholdAssetManager.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPool} from "./dependencies/aave-v3/IPool.sol";

/**
 * @title Asset Manager that deploys the funds into an ERC4626 vault
 * @dev Using liquidity thresholds defined in {LiquidityThresholdAssetManager}, deploys the funds into AAVEv3.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract AAVEv3AssetManager is LiquidityThresholdAssetManager {
  bytes32 internal constant DATA_PROVIDER_ID =
    0x0100000000000000000000000000000000000000000000000000000000000000;

  IPool internal immutable _aave;
  IERC20Metadata internal immutable _aToken;

  constructor(IERC20Metadata asset_, IPool aave_) LiquidityThresholdAssetManager(asset_) {
    _aave = aave_;
    _aToken = IERC20Metadata(aave_.getReserveData(address(asset_)).aTokenAddress);
  }

  function connect() public override {
    super.connect();
    _asset.approve(address(_aave), type(uint256).max); // infinite approval to the AAVE lending pool
  }

  function _invest(uint256 amount) internal override {
    super._invest(amount);
    _aave.supply(address(_asset), amount, address(this), 0);
  }

  function _deinvest(uint256 amount) internal override {
    super._deinvest(amount);
    _aave.withdraw(address(_asset), amount, address(this));
  }

  function deinvestAll() external override returns (int256 earnings) {
    DiamondStorage storage ds = diamondStorage();
    uint256 withdrawn = (_aToken.balanceOf(address(this)) != 0)
      ? _aave.withdraw(address(_asset), type(uint256).max, address(this))
      : 0;
    earnings = int256(withdrawn) - int256(uint256(ds.lastInvestmentValue));
    ds.lastInvestmentValue = 0;
    emit MoneyDeinvested(withdrawn);
    emit EarningsRecorded(earnings);
    return earnings;
  }

  function getInvestmentValue() public view override returns (uint256) {
    return _aToken.balanceOf(address(this));
  }
}
