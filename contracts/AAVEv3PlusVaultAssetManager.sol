// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {AAVEv3AssetManager} from "./AAVEv3AssetManager.sol";
import {LiquidityThresholdAssetManager} from "@ensuro/core/contracts/LiquidityThresholdAssetManager.sol";
import {IPool} from "./dependencies/aave-v3/IPool.sol";

/**
 * @title Asset Manager that deploys the funds into AAVEv3 but also, at request, can deploy the funds in a vault.
 * @dev Using liquidity thresholds defined in {LiquidityThresholdAssetManager}, deploys the funds into AAVEv3.
 *      By request of the administrator it can also deploy the funds in a vault. When deinvesting, it AAVEv3 funds
 *      aren't enough for the required amount, it tries to withdraw from the vault.
 * @custom:security-contact security@ensuro.co
 * @author Ensuro
 */
contract AAVEv3PlusVaultAssetManager is AAVEv3AssetManager {
  IERC4626 internal immutable _vault;

  constructor(
    IERC20Metadata asset_,
    IPool aave_,
    IERC4626 vault_
  ) AAVEv3AssetManager(asset_, aave_) {
    require(
      address(vault_) != address(0),
      "AAVEv3PlusVaultAssetManager: vault cannot be zero address"
    );
    require(address(asset_) != vault_.asset(), "ERC4626AssetManager: vault cannot be zero address");
    _vault = vault_;
  }

  function _deinvest(uint256 amount) internal virtual override {
    LiquidityThresholdAssetManager._deinvest(amount);
    uint256 aaveAmount = Math.min(amount, _aToken.balanceOf(address(this)));
    if (aaveAmount != 0) _aave.withdraw(address(_asset), aaveAmount, address(this));
    if (amount - aaveAmount != 0)
      _vault.withdraw(amount - aaveAmount, address(this), address(this));
  }

  function connect() public override {
    super.connect();
    _asset.approve(address(_vault), type(uint256).max); // infinite approval to the vault
  }

  function deinvestAll() external virtual override returns (int256 earnings) {
    DiamondStorage storage ds = diamondStorage();
    uint256 fromAAVE = (_aToken.balanceOf(address(this)) != 0)
      ? _aave.withdraw(address(_asset), type(uint256).max, address(this))
      : 0;
    /**
     * WARNING: this was implemented withdrawing as much as possible from the vault WITHOUT failing.
     * This implementation might leave some assets (those that aren't withdrawable) in the vault and those will
     * be reported as losses.
     */
    uint256 redeemable = _vault.maxRedeem(address(this));
    uint256 fromVault = redeemable != 0
      ? _vault.redeem(redeemable, address(this), address(this))
      : 0;
    earnings = int256(fromAAVE + fromVault) - int256(uint256(ds.lastInvestmentValue));
    ds.lastInvestmentValue = 0;
    emit MoneyDeinvested(fromAAVE + fromVault);
    emit EarningsRecorded(earnings);
    return earnings;
  }

  function getInvestmentValue() public view virtual override returns (uint256) {
    return
      _aToken.balanceOf(address(this)) + _vault.convertToAssets(_vault.balanceOf(address(this)));
  }

  /**
   * @dev Transfers the given amount from AAVE to the vault
   *
   * @param amount The amount to transfer. If that amount isn't available in AAVE it reverts.
   *               If amount = type(uint256).max it withdraws all the funds from AAVE.
   */
  function aaveToVault(uint256 amount) external {
    uint256 withdrawn = _aave.withdraw(address(_asset), amount, address(this));
    _vault.deposit(withdrawn, address(this));
  }

  /**
   * @dev Transfers the given amount from the vault to AAVE
   *
   * @param amount The amount to transfer. If that amount isn't available in the vault it reverts.
   *               If amount = type(uint256).max it withdraws all the funds withdrawable in the vault
   */
  function vaultToAave(uint256 amount) external {
    uint256 withdrawn;
    if (amount == type(uint256).max) {
      withdrawn = _vault.redeem(_vault.maxRedeem(address(this)), address(this), address(this));
    } else {
      _vault.withdraw(amount, address(this), address(this));
      withdrawn = amount;
    }
    _aave.supply(address(_asset), withdrawn, address(this), 0);
  }
}
